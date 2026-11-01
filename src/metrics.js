import { TENANTS } from "./common.js";
const BOUNDS = [0.1, 0.3, 0.5, 1, 2, 5, 10];
export class Metrics {
  constructor() {
    this.tenants = Object.fromEntries(
      TENANTS.map((t) => [
        t,
        {
          requests: 0,
          success: 0,
          fallback: 0,
          failed: 0,
          rejected: 0,
          attempts: 0,
          timeouts: 0,
          upstreamErrors: 0,
          durationSum: 0,
          buckets: BOUNDS.map(() => 0),
          recent: [],
        },
      ]),
    );
  }
  observe(tenant, outcome, seconds) {
    const row = this.tenants[tenant];
    row.requests++;
    row[outcome]++;
    row.durationSum += seconds;
    BOUNDS.forEach((b, i) => {
      if (seconds <= b) row.buckets[i]++;
    });
    row.recent.push(seconds);
    if (row.recent.length > 100) row.recent.shift();
  }
  snapshot() {
    return Object.fromEntries(
      Object.entries(this.tenants).map(([tenant, r]) => {
        const sorted = [...r.recent].sort((a, b) => a - b);
        const { buckets, recent, durationSum, ...counts } = r;
        return [
          tenant,
          {
            ...counts,
            p95Ms: sorted.length
              ? Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 1000)
              : null,
          },
        ];
      }),
    );
  }
  prometheus(state) {
    const out = [
      "# HELP shoptalk_chat_requests_total テナントと結果ごとのチャット要求数",
      "# TYPE shoptalk_chat_requests_total counter",
    ];
    for (const [tenant, r] of Object.entries(this.tenants)) {
      for (const outcome of ["success", "fallback", "failed", "rejected"]) {
        out.push(
          `shoptalk_chat_requests_total{tenant="${tenant}",outcome="${outcome}"} ${r[outcome]}`,
        );
      }
    }
    for (const [name, key] of [
      ["attempts", "attempts"],
      ["timeouts", "timeouts"],
      ["errors", "upstreamErrors"],
    ]) {
      out.push(`# TYPE shoptalk_ai_${name}_total counter`);
      for (const [tenant, r] of Object.entries(this.tenants))
        out.push(`shoptalk_ai_${name}_total{tenant="${tenant}"} ${r[key]}`);
    }
    out.push("# TYPE shoptalk_chat_duration_seconds histogram");
    for (const [tenant, r] of Object.entries(this.tenants)) {
      BOUNDS.forEach((bound, i) =>
        out.push(
          `shoptalk_chat_duration_seconds_bucket{tenant="${tenant}",le="${bound}"} ${r.buckets[i]}`,
        ),
      );
      out.push(
        `shoptalk_chat_duration_seconds_bucket{tenant="${tenant}",le="+Inf"} ${r.requests}`,
      );
      out.push(
        `shoptalk_chat_duration_seconds_sum{tenant="${tenant}"} ${r.durationSum}`,
      );
      out.push(
        `shoptalk_chat_duration_seconds_count{tenant="${tenant}"} ${r.requests}`,
      );
    }
    for (const key of [
      "inflight",
      "queue_depth",
      "recorded",
      "queue_capacity",
    ]) {
      out.push(
        `# TYPE shoptalk_${key} ${key === "recorded" ? "counter" : "gauge"}`,
      );
      out.push(`shoptalk_${key} ${state[key]}`);
    }
    return out.join("\n") + "\n";
  }
}
