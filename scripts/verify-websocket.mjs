import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";

loadEnv(process.argv[2] ?? ".env.production");

const input = process.env.WEBSOCKET_URL ?? `${process.env.API_BASE_URL ?? process.env.PUBLIC_API_BASE_URL ?? "http://localhost:7073"}/api/live/ws`;
const url = new URL(input.replace(/^http:/, "ws:").replace(/^https:/, "wss:"));
const timeoutMs = Number(process.env.WEBSOCKET_VERIFY_TIMEOUT_MS ?? 10_000);
const key = randomBytes(16).toString("base64");
const expectedAccept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

const socket = url.protocol === "wss:"
  ? connectTls({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname })
  : connect({ host: url.hostname, port: Number(url.port || 80) });

const timeout = setTimeout(() => fail(`Timed out after ${timeoutMs}ms.`), timeoutMs);
let response = "";
let upgradeSent = false;
let completed = false;

socket.once("connect", sendUpgrade);
socket.once("secureConnect", sendUpgrade);
socket.on("data", (chunk) => {
  if (completed) return;
  response += chunk.toString("latin1");
  if (!response.includes("\r\n\r\n")) return;
  const [head] = response.split("\r\n\r\n");
  const lines = head.split("\r\n");
  const status = lines.shift() ?? "";
  const headers = new Map(lines.map((line) => {
    const separator = line.indexOf(":");
    return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
  }));
  if (!status.includes(" 101 ")) return fail(`Expected HTTP 101, received ${status}.`);
  if (headers.get("sec-websocket-accept") !== expectedAccept) return fail("Invalid Sec-WebSocket-Accept response.");
  completed = true;
  clearTimeout(timeout);
  console.log(JSON.stringify({ status: "PASS", url: url.toString(), upgrade: status, protocol: url.protocol }, null, 2));
  socket.end();
});
socket.on("error", (error) => fail(error.message));

function sendUpgrade() {
  if (socket.destroyed || upgradeSent) return;
  upgradeSent = true;
  socket.write([
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "Origin: https://fx.bijaysubbalimbu.com.np",
    "",
    ""
  ].join("\r\n"));
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function fail(message) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  socket.destroy();
  console.error(JSON.stringify({ status: "FAIL", url: url.toString(), message }, null, 2));
  process.exit(1);
}
