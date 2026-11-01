import { createApp } from "./app.js";
import { createAI } from "./ai.js";
import { log } from "./common.js";
const role = process.env.SERVICE_ROLE || "api";
if (!["api", "ai"].includes(role))
  throw new Error("SERVICE_ROLE は api または ai を指定してください。");
const instance =
  role === "ai"
    ? createAI({ token: process.env.LAB_TOKEN })
    : createApp({
        token: process.env.LAB_TOKEN,
        aiUrl: process.env.AI_URL || "http://127.0.0.1:8081",
      });
const port = Number(process.env.PORT || (role === "ai" ? 8081 : 8080));
instance.server.listen(port, "0.0.0.0", () =>
  log({ event: "listening", role, port }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    instance.stop?.();
    instance.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 12000).unref();
  });
