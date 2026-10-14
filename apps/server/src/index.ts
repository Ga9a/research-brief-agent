import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: [resolve(serverRoot, ".env.local"), resolve(serverRoot, ".env"), resolve(process.cwd(), ".env.local"), resolve(process.cwd(), ".env")] });
const port = Number(process.env.PORT || "3001");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
const host = process.env.HOST || "127.0.0.1";
createApp().listen(port, host, () => console.log(`Server listening at http://${host}:${port}`));
