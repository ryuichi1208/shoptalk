import http from "node:http";
import {
  authorized,
  body,
  json,
  log,
  sleep,
  configureServer,
  TENANTS,
  SCENARIOS,
} from "./common.js";
export function createAI({
  token,
  logger = log,
  normalDelay = 80,
  slowDelay = 2500,
} = {}) {
  if (!token || token.length < 16)
    throw new Error("LAB_TOKEN は16文字以上で指定してください。");
  let active = 0;
  let total = 0;
  let failed = 0;
  const server = configureServer(
    http.createServer(async (req, res) => {
      try {
        if (req.method === "GET" && ["/healthz", "/readyz"].includes(req.url))
          return json(res, 200, { status: "ok" });
        if (req.method === "GET" && req.url === "/metrics") {
          res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
          return res.end(
            `# TYPE shoptalk_ai_active gauge\nshoptalk_ai_active ${active}\n# TYPE shoptalk_ai_received_total counter\nshoptalk_ai_received_total ${total}\n# TYPE shoptalk_ai_failed_total counter\nshoptalk_ai_failed_total ${failed}\n`,
          );
        }
        if (req.method !== "POST" || req.url !== "/generate")
          return json(res, 404, { error: "見つかりません。" });
        if (!authorized(req, token))
          return json(res, 401, { error: "認証が必要です。" });
        const input = await body(req);
        if (
          !TENANTS.includes(input.tenant) ||
          !SCENARIOS.includes(input.scenario) ||
          typeof input.message !== "string" ||
          input.message.length > 500
        ) {
          return json(res, 400, { error: "入力を確認してください。" });
        }
        total++;
        if (active >= 64) {
          failed++;
          return json(res, 503, { error: "capacity" });
        }
        active++;
        const start = performance.now();
        try {
          const slow =
            input.scenario === "ai-latency" ||
            (input.scenario === "tenant-latency" && input.tenant === "harbor");
          // 外部サービスでは、呼び出し元がタイムアウトしても処理が続く場合があります。
          await sleep(slow ? slowDelay : normalDelay);
          if (input.scenario === "retry-storm") {
            failed++;
            if (!res.destroyed)
              json(res, 503, { error: "dependency_unavailable" });
          } else if (!res.destroyed) {
            json(res, 200, {
              reply:
                "お問い合わせを受け付けました。注文変更の依頼を記録し、確認後にご案内します。（演習用の定型応答です）",
            });
          }
        } finally {
          active--;
          logger({
            event: "ai_completed",
            requestId: req.headers["x-request-id"],
            tenant: input.tenant,
            scenario: input.scenario,
            active,
            durationMs: Math.round(performance.now() - start),
            disconnected: res.destroyed,
          });
        }
      } catch (error) {
        if (!res.headersSent && !res.destroyed)
          json(res, error.status || 500, {
            error: error.status ? error.message : "処理に失敗しました。",
          });
      }
    }),
  );
  return { server };
}
