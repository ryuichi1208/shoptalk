const form = document.querySelector("#chat-form");
const input = document.querySelector("#message");
const tenant = document.querySelector("#tenant");
const send = document.querySelector("#send");
const messages = document.querySelector("#messages");
function append(text, kind) {
  const item = document.createElement("div");
  item.className = `message ${kind}`;
  item.textContent = text;
  messages.append(item);
  item.scrollIntoView({ block: "nearest" });
  return item;
}
document.querySelector("#suggest").addEventListener("click", () => {
  input.value = "注文の配送先を変更したいです。";
  input.focus();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!input.value.trim() || send.disabled) return;
  const text = input.value.trim();
  const selected = tenant.value;
  append(text, "customer");
  input.value = "";
  send.disabled = true;
  tenant.disabled = true;
  const pending = append("回答を準備しています…", "assistant pending");
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant: selected, message: text }),
      signal: AbortSignal.timeout(14000),
    });
    const result = await response.json();
    pending.textContent = result.reply || result.error;
    pending.className = `message assistant ${response.ok ? "" : "error"}`;
    if (result.requestId) {
      const ref = document.createElement("small");
      ref.textContent = `照会ID: ${result.requestId}`;
      pending.append(ref);
    }
  } catch {
    pending.textContent =
      "接続を確認できませんでした。受付状況が不明なため、演習画面の記録で確認してください。";
    pending.className = "message assistant error";
  } finally {
    send.disabled = false;
    tenant.disabled = false;
    input.focus();
  }
});
