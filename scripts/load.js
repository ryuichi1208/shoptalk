const target = process.env.TARGET_URL || "http://localhost:8080";
const duration = Number(process.env.DURATION_SECONDS || 30);
const concurrency = Number(process.env.CONCURRENCY || 4);
if (
  !Number.isInteger(duration) ||
  duration < 1 ||
  duration > 3600 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 32
) {
  throw new Error(
    "DURATION_SECONDS は1〜3600、CONCURRENCY は1〜32の整数にしてください。",
  );
}
const until = Date.now() + duration * 1000;
const counts = {};
let sequence = 0;
const tenants = ["harbor", "maple", "cedar"];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (Date.now() < until) {
      const tenant = tenants[sequence++ % tenants.length];
      try {
        const response = await fetch(`${target}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenant,
            message: "注文の配送先を変更したいです。",
          }),
          signal: AbortSignal.timeout(14000),
        });
        const result = await response.json();
        const key = `${tenant}:${result.outcome || response.status}`;
        counts[key] = (counts[key] || 0) + 1;
      } catch {
        counts.connection_error = (counts.connection_error || 0) + 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }),
);
console.log(
  JSON.stringify({ durationSeconds: duration, concurrency, counts }, null, 2),
);
