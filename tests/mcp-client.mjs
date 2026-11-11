// Minimal MCP stdio client used by the smoke / end-to-end tests.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function connect() {
  const p = spawn(process.execPath, [path.join(root, "dist/index.js")], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  let id = 0;
  const waiters = {};
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id && waiters[m.id]) waiters[m.id](m);
    }
  });
  const req = (method, params) =>
    new Promise((r) => {
      const i = ++id;
      waiters[i] = r;
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    });
  await req("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  async function call(name, args = {}) {
    const t = Date.now();
    const r = await req("tools/call", { name, arguments: args });
    const res = r.result || { isError: true, content: [{ type: "text", text: JSON.stringify(r.error) }] };
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    const images = res.content.filter((c) => c.type === "image");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: !res.isError, data, images, ms: Date.now() - t };
  }
  return { call, req, close: () => p.kill() };
}
