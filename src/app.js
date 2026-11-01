import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  TENANTS,
  SCENARIOS,
  authorized,
  body,
  json,
  log,
  sleep,
  configureServer,
} from "./common.js";
import { Metrics } from "./metrics.js";

export function createApp({
  aiUrl,
  token,
  logger = log,
  workerInterval = 50,
} = {}) {
  if (!token || token.length < 16)
    throw new Error("LAB_TOKEN は16文字以上で指定してください。");
  const metrics = new Metrics();
  let config = {
    scenario: "normal",
    retries: 2,
    timeoutMs: 1000,
    fallback: false,
    maxInflight: 8,
  };
  const queue = [];
  const events = [];
  const recentRecords = [];
  const capacity = 200;
  let inflight = 0;
  let recorded = 0;
  let stopping = false;
  const startedAt = new Date().toISOString();
  function event(entry) {
    const item = { time: new Date().toISOString(), ...entry };
    events.unshift(item);
    if (events.length > 30) events.pop();
    logger(item);
  }
  function state() {
    return {
      inflight,
      queue_depth: queue.length,
      recorded,
      queue_capacity: capacity,
    };
  }
  const timer = setInterval(() => {
    if (config.scenario === "queue-backlog") return;
    const item = queue.shift();
    if (item) {
      recorded++;
      recentRecords.unshift({ ...item, recordedAt: new Date().toISOString() });
      if (recentRecords.length > 20) recentRecords.pop();
      event({
        event: "record_completed",
        requestId: item.requestId,
        tenant: item.tenant,
      });
    }
  }, workerInterval);
  timer.unref();
  const files = new Map([
    ["/", ["index.html", "text/html"]],
    ["/lab", ["lab.html", "text/html"]],
    ["/style.css", ["style.css", "text/css"]],
    ["/chat.js", ["chat.js", "text/javascript"]],
    ["/lab.js", ["lab.js", "text/javascript"]],
  ]);
  const server = configureServer(
    http.createServer(async (req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      try {
        const path = new URL(req.url, "http://localhost").pathname;
        if (
          req.method === "GET" &&
          (path === "/healthz" || path === "/readyz")
        ) {
          return json(res, stopping ? 503 : 200, {
            status: stopping ? "stopping" : "ok",
          });
        }
        if (req.method === "GET" && path === "/api/status") {
          return json(res, 200, {
            startedAt,
            config,
            ...state(),
            tenants: metrics.snapshot(),
            events,
            recentRecords,
          });
        }
        if (req.method === "GET" && path === "/metrics") {
          res.writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          });
          return res.end(metrics.prometheus(state()));
        }
        if (req.method === "POST" && path === "/api/config") {
          if (!authorized(req, token))
            return json(res, 401, {
              error: "演習用トークンを確認してください。",
            });
          const patch = await body(req);
          const keys = [
            "scenario",
            "retries",
            "timeoutMs",
            "fallback",
            "maxInflight",
          ];
          if (Object.keys(patch).some((k) => !keys.includes(k)))
            return json(res, 400, { error: "不明な設定項目です。" });
          const next = { ...config, ...patch };
          if (
            !SCENARIOS.includes(next.scenario) ||
            !Number.isInteger(next.retries) ||
            next.retries < 0 ||
            next.retries > 3 ||
            !Number.isInteger(next.timeoutMs) ||
            next.timeoutMs < 50 ||
            next.timeoutMs > 3000 ||
            typeof next.fallback !== "boolean" ||
            !Number.isInteger(next.maxInflight) ||
            next.maxInflight < 1 ||
            next.maxInflight > 32
          ) {
            return json(res, 400, { error: "設定値が許容範囲外です。" });
          }
          config = next;
          event({ event: "config_changed", config });
          return json(res, 200, config);
        }
        if (req.method === "POST" && path === "/api/chat") {
          const input = await body(req);
          if (
            !TENANTS.includes(input.tenant) ||
            typeof input.message !== "string" ||
            !input.message.trim() ||
            input.message.length > 500
          ) {
            return json(res, 400, {
              error: "店舗と1〜500文字の問い合わせを指定してください。",
            });
          }
          const { tenant } = input;
          const requestId = randomUUID();
          res.setHeader("X-Request-ID", requestId);
          const began = performance.now();
          const current = { ...config };
          const finish = (status, outcome, result) => {
            const duration = (performance.now() - began) / 1000;
            metrics.observe(tenant, outcome, duration);
            event({
              event: "chat_completed",
              requestId,
              tenant,
              outcome,
              durationMs: Math.round(duration * 1000),
            });
            if (!res.destroyed)
              json(res, status, { ...result, requestId, outcome });
          };
          // 実行中の要求分も予約し、同時完了でキュー上限を超えないようにします。
          if (
            stopping ||
            inflight >= current.maxInflight ||
            queue.length + inflight >= capacity
          ) {
            res.setHeader("Retry-After", "2");
            return finish(503, "rejected", {
              error:
                "ただいま混み合っています。少し時間をおいてお試しください。",
            });
          }
          inflight++;
          let reply;
          try {
            if (current.fallback) {
              return finish(200, "fallback", {
                reply:
                  "ただいま自動回答を制限しています。注文の変更はまだ受け付けていません。時間をおいて再度お問い合わせください。",
                recorded: false,
              });
            }
            for (let attempt = 0; attempt <= current.retries; attempt++) {
              metrics.tenants[tenant].attempts++;
              try {
                const upstream = await fetch(`${aiUrl}/generate`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    "X-Request-ID": requestId,
                  },
                  body: JSON.stringify({
                    tenant,
                    message: input.message,
                    scenario: current.scenario,
                  }),
                  signal: AbortSignal.timeout(current.timeoutMs),
                });
                const result = await upstream.json();
                if (!upstream.ok || typeof result.reply !== "string")
                  throw new Error(`upstream_${upstream.status}`);
                reply = result.reply;
                break;
              } catch (error) {
                if (error.name === "TimeoutError")
                  metrics.tenants[tenant].timeouts++;
                else metrics.tenants[tenant].upstreamErrors++;
                event({
                  event: "ai_attempt_failed",
                  requestId,
                  tenant,
                  attempt: attempt + 1,
                  reason:
                    error.name === "TimeoutError"
                      ? "timeout"
                      : "upstream_error",
                });
                if (attempt < current.retries) await sleep(50 * 2 ** attempt);
              }
            }
            if (!reply)
              return finish(504, "failed", {
                error:
                  "回答が間に合いませんでした。注文変更の受付は完了していません。",
              });
            queue.push({
              requestId,
              tenant,
              acceptedAt: new Date().toISOString(),
            });
            return finish(200, "success", {
              reply,
              recorded: false,
              recordStatus: "pending",
            });
          } finally {
            inflight--;
          }
        }
        if (req.method === "GET" && files.has(path)) {
          const [name, type] = files.get(path);
          const content = await readFile(
            new URL(`../public/${name}`, import.meta.url),
          );
          res.writeHead(200, {
            "Content-Type": `${type}; charset=utf-8`,
            "Cache-Control": "no-cache",
          });
          return res.end(content);
        }
        json(res, 404, { error: "見つかりません。" });
      } catch (error) {
        if (!res.headersSent && !res.destroyed)
          json(res, error.status || 500, {
            error: error.status ? error.message : "処理に失敗しました。",
          });
        if (!error.status)
          logger({ event: "internal_error", error: error.message });
      }
    }),
  );
  server.on("close", () => clearInterval(timer));
  return {
    server,
    metrics,
    stop: () => {
      stopping = true;
      clearInterval(timer);
    },
  };
}
