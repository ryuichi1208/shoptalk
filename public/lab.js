const $ = (id) => document.getElementById(id);
const names = {
  harbor: "Harbor Store",
  maple: "Maple Market",
  cedar: "Cedar Shop",
};
const defaults = {
  scenario: "normal",
  retries: 2,
  timeoutMs: 1000,
  fallback: false,
  maxInflight: 8,
};
let initialized = false;
function populate(config) {
  $("scenario").value = config.scenario;
  $("retries").value = config.retries;
  $("timeout").value = config.timeoutMs;
  $("max-inflight").value = config.maxInflight;
  $("fallback").checked = config.fallback;
}
async function refresh() {
  try {
    const response = await fetch("/api/status", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("status");
    const status = await response.json();
    $("connection").textContent =
      `最終取得 ${new Date().toLocaleTimeString("ja-JP")} · 接続中`;
    $("inflight").textContent = status.inflight;
    $("queued").textContent = status.queue_depth;
    $("recorded").textContent = status.recorded;
    let attempts = 0;
    let requests = 0;
    const rows = [];
    for (const [tenant, item] of Object.entries(status.tenants)) {
      attempts += item.attempts;
      requests += item.requests;
      const row = document.createElement("tr");
      for (const value of [
        names[tenant],
        item.requests,
        item.success,
        item.fallback,
        item.failed,
        item.rejected,
        item.p95Ms === null ? "—" : `${item.p95Ms} ms`,
        item.attempts,
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      rows.push(row);
    }
    $("tenants").replaceChildren(...rows);
    $("amplification").textContent = requests
      ? `${(attempts / requests).toFixed(1)}×`
      : "—";
    $("current-config").textContent = JSON.stringify(status.config, null, 2);
    $("events").textContent =
      status.events.map((event) => JSON.stringify(event)).join("\n") ||
      "まだイベントはありません。チャットから問い合わせてください。";
    if (!initialized) {
      populate(status.config);
      initialized = true;
    }
  } catch {
    $("connection").textContent =
      "取得できません。表示値は最新ではありません。";
  }
}
async function update(config) {
  $("config-result").textContent = "適用しています…";
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${$("token").value}`,
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    populate(result);
    $("config-result").textContent =
      "適用しました。進行中の要求と累計値は維持しています。";
    await refresh();
  } catch (error) {
    $("config-result").textContent = `適用できませんでした: ${error.message}`;
  }
}
$("controls").addEventListener("submit", (event) => {
  event.preventDefault();
  update({
    scenario: $("scenario").value,
    retries: Number($("retries").value),
    timeoutMs: Number($("timeout").value),
    maxInflight: Number($("max-inflight").value),
    fallback: $("fallback").checked,
  });
});
$("reset").addEventListener("click", () => update(defaults));
async function poll() {
  await refresh();
  setTimeout(poll, 2000);
}
poll();
