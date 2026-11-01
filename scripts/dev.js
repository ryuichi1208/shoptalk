import { randomBytes } from "node:crypto";
import { createApp } from "../src/app.js";
import { createAI } from "../src/ai.js";
const token = process.env.LAB_TOKEN || randomBytes(24).toString("hex");
const ai = createAI({ token });
const app = createApp({ token, aiUrl: "http://127.0.0.1:8081" });
ai.server.listen(8081, "127.0.0.1");
app.server.listen(8080, "127.0.0.1");
console.log(
  "ShopTalk: http://localhost:8080\n演習画面: http://localhost:8080/lab",
);
console.log(`演習用トークン（ローカル専用）: ${token}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    app.stop();
    app.server.close();
    ai.server.close();
    setTimeout(() => process.exit(0), 12000).unref();
  });
