import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { createAI } from "../src/ai.js";
import { sleep } from "../src/common.js";
const token = "test-only-token-never-deploy";
async function fixture(t, options = {}) {
  const ai = createAI({
    token,
    logger: () => {},
    normalDelay: 10,
    slowDelay: 250,
    ...options,
  });
  ai.server.listen(0, "127.0.0.1");
  await once(ai.server, "listening");
  const app = createApp({
    token,
    logger: () => {},
    aiUrl: `http://127.0.0.1:${ai.server.address().port}`,
    workerInterval: 10,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.stop();
    for (const server of [app.server, ai.server]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, data, secret = token) => {
    const response = await fetch(
      base + path,
      data === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify(data),
          },
    );
    return { status: response.status, body: await response.json() };
  };
  const chat = (tenant = "harbor") =>
    request("/api/chat", { tenant, message: "配送先を変更したいです。" });
  const configure = (patch) => request("/api/config", patch);
  const status = async () => (await request("/api/status")).body;
  return { base, request, chat, configure, status };
}

test("通常応答後に受付記録が非同期で完了する", async (t) => {
  const { chat, status } = await fixture(t);
  const response = await chat();
  assert.equal(response.status, 200);
  assert.equal(response.body.outcome, "success");
  assert.equal(response.body.recordStatus, "pending");
  await sleep(40);
  const state = await status();
  assert.equal(state.recorded, 1);
  assert.equal(state.queue_depth, 0);
  assert.equal(state.recentRecords[0].requestId, response.body.requestId);
});

test("Harborだけの遅延を他テナントから分離し、再試行は上限内に収める", async (t) => {
  const { configure, chat, status } = await fixture(t);
  await configure({ scenario: "tenant-latency", retries: 1, timeoutMs: 50 });
  const [harbor, maple] = await Promise.all([chat("harbor"), chat("maple")]);
  assert.equal(harbor.status, 504);
  assert.equal(maple.status, 200);
  const state = await status();
  assert.equal(state.tenants.harbor.attempts, 2);
  assert.equal(state.tenants.harbor.timeouts, 2);
  assert.equal(state.tenants.maple.attempts, 1);
  assert.equal(state.inflight, 0);
});

test("依存先503に対する再試行抑制と縮退で呼び出し数を減らす", async (t) => {
  const { configure, chat, status } = await fixture(t);
  await configure({ scenario: "retry-storm", retries: 2 });
  assert.equal((await chat()).status, 504);
  assert.equal((await status()).tenants.harbor.attempts, 3);
  await configure({ retries: 0 });
  assert.equal((await chat()).status, 504);
  assert.equal((await status()).tenants.harbor.attempts, 4);
  await configure({ fallback: true });
  const reply = await chat();
  assert.equal(reply.body.outcome, "fallback");
  const state = await status();
  assert.equal(state.tenants.harbor.attempts, 4);
  assert.equal(state.recorded + state.queue_depth, 0);
});

test("受付制限で処理中の要求を増やさず、終了後に枠を戻す", async (t) => {
  const { configure, chat, status } = await fixture(t, { normalDelay: 150 });
  await configure({ maxInflight: 1 });
  const first = chat();
  for (let i = 0; i < 20 && (await status()).inflight === 0; i++)
    await sleep(5);
  const second = await chat("maple");
  assert.equal(second.status, 503);
  assert.equal(second.body.outcome, "rejected");
  assert.equal((await first).status, 200);
  assert.equal((await status()).inflight, 0);
  assert.equal((await chat("maple")).status, 200);
});

test("記録停止中はキューに残り、復旧後に重複なく処理する", async (t) => {
  const { configure, chat, status } = await fixture(t);
  await configure({ scenario: "queue-backlog" });
  const response = await chat();
  await sleep(30);
  assert.equal((await status()).queue_depth, 1);
  assert.equal((await status()).recorded, 0);
  await configure({ scenario: "normal" });
  await sleep(40);
  const state = await status();
  assert.equal(state.queue_depth, 0);
  assert.equal(state.recorded, 1);
  assert.equal(state.recentRecords[0].requestId, response.body.requestId);
});

test("管理認証、入力検証、メトリクスの結果分類", async (t) => {
  const { request, configure, chat, base } = await fixture(t);
  assert.equal(
    (await request("/api/config", { fallback: true }, "wrong")).status,
    401,
  );
  assert.equal((await configure({ retries: 99 })).status, 400);
  assert.equal((await configure({ arbitrary: true })).status, 400);
  assert.equal(
    (await request("/api/chat", { tenant: "unknown", message: "hello" }))
      .status,
    400,
  );
  assert.equal(
    (await request("/api/chat", { tenant: "harbor", message: "x".repeat(501) }))
      .status,
    400,
  );
  const invalid = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(invalid.status, 400);
  await chat();
  await configure({ fallback: true });
  await chat();
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(
    metrics,
    /shoptalk_chat_requests_total\{tenant="harbor",outcome="success"\} 1/,
  );
  assert.match(
    metrics,
    /shoptalk_chat_requests_total\{tenant="harbor",outcome="fallback"\} 1/,
  );
  assert.match(
    metrics,
    /shoptalk_chat_duration_seconds_count\{tenant="harbor"\} 2/,
  );
  assert.match(metrics, /shoptalk_ai_attempts_total\{tenant="harbor"\} 1/);
});

test("キュー上限に到達すると受付を制限し、記録を無制限に増やさない", async (t) => {
  const { configure, chat, status } = await fixture(t, { normalDelay: 0 });
  await configure({ scenario: "queue-backlog", maxInflight: 32 });
  const replies = [];
  for (let batch = 0; batch < 11; batch++)
    replies.push(
      ...(await Promise.all(Array.from({ length: 20 }, () => chat()))),
    );
  const state = await status();
  assert.equal(state.queue_depth, 200);
  assert.equal(state.recorded, 0);
  assert.equal(state.inflight, 0);
  assert.equal(replies.filter((reply) => reply.status === 200).length, 200);
  assert.equal(replies.filter((reply) => reply.status === 503).length, 20);
});

test("大きすぎる本文には413を返し、サーバーは処理を継続する", async (t) => {
  const { base, chat } = await fixture(t);
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenant: "harbor", message: "x".repeat(10000) }),
  });
  assert.equal(response.status, 413);
  assert.equal((await chat()).status, 200);
});
