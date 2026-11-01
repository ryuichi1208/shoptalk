import { timingSafeEqual } from "node:crypto";

export const TENANTS = ["harbor", "maple", "cedar"];
export const SCENARIOS = [
  "normal",
  "tenant-latency",
  "ai-latency",
  "retry-storm",
  "queue-backlog",
];
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const log = (event) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
export function authorized(req, token) {
  const supplied = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
export function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
export async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw Object.assign(
      new Error("Content-Type は application/json を指定してください。"),
      { status: 415 },
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192)
      throw Object.assign(new Error("送信内容が大きすぎます。"), {
        status: 413,
      });
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSONの形式を確認してください。"), {
      status: 400,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("JSONオブジェクトを指定してください。"), {
      status: 400,
    });
  }
  return value;
}
export function configureServer(server) {
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  server.maxHeadersCount = 40;
  return server;
}
