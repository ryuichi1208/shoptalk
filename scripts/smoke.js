import assert from "node:assert/strict";
const target = process.env.TARGET_URL || "http://localhost:8080";
const token = process.env.LAB_TOKEN;
if (!token)
  throw new Error(
    "LAB_TOKEN を指定してください。専用の演習環境で実行してください。",
  );
const defaults = {
  scenario: "normal",
  retries: 2,
  timeoutMs: 1000,
  fallback: false,
  maxInflight: 8,
};
async function request(path, data, auth = token) {
  const response = await fetch(
    target + path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth}`,
          },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(14000),
        },
  );
  return { status: response.status, data: await response.json() };
}
async function configure(config) {
  assert.equal((await request("/api/config", config)).status, 200);
}
const chat = (tenant) =>
  request("/api/chat", { tenant, message: "配送先を変更したいです。" });
try {
  assert.equal((await request("/healthz")).status, 200);
  assert.equal(
    (await request("/api/config", { fallback: true }, "wrong-token")).status,
    401,
  );
  await configure(defaults);
  assert.equal((await chat("harbor")).data.outcome, "success");
  await configure({ scenario: "tenant-latency", retries: 0, timeoutMs: 500 });
  assert.equal((await chat("harbor")).status, 504);
  assert.equal((await chat("maple")).status, 200);
  await configure({ scenario: "ai-latency" });
  assert.equal((await chat("maple")).status, 504);
  await configure({ fallback: true });
  assert.equal((await chat("maple")).data.outcome, "fallback");
  await configure({ scenario: "retry-storm", retries: 2, fallback: false });
  const before = (await request("/api/status")).data.tenants.cedar.attempts;
  assert.equal((await chat("cedar")).status, 504);
  assert.equal(
    (await request("/api/status")).data.tenants.cedar.attempts - before,
    3,
  );
  await configure({ ...defaults, scenario: "queue-backlog" });
  const record = await chat("cedar");
  assert.equal(record.status, 200);
  assert.ok((await request("/api/status")).data.queue_depth >= 1);
  await configure(defaults);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const state = (await request("/api/status")).data;
  assert.equal(state.queue_depth, 0);
  assert.ok(
    state.recentRecords.some(
      (entry) => entry.requestId === record.data.requestId,
    ),
  );
  assert.equal((await fetch(target + "/metrics")).status, 200);
  console.log(
    "正常応答、認証、テナント別遅延、AI遅延、縮退、リトライ、記録再開の確認に成功しました。",
  );
} finally {
  await configure(defaults);
}
