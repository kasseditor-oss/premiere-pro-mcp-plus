// Minimal MCP stdio client used by the smoke / end-to-end tests.
// connect(env) starts the server with extra environment variables. By default
// tests run with every permission profile and without confirmation tokens;
// the policy tests pass their own env.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function connect(env = {}) {
  const p = spawn(process.execPath, [path.join(root, "dist/index.js")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PREMIERE_MCP_PROFILES: "all", PREMIERE_MCP_CONFIRM: "0", PREMIERE_MCP_UXP: process.env.PREMIERE_MCP_UXP ?? "1", ...env },
  });
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
  // Tool results use the envelope {ok, tool, status, data | error}; tests see
  // data (or {code, error, hint} on failure) plus status / warning / envelope.
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
    let status, warning, envelope;
    if (data && typeof data === "object" && "tool" in data && "ok" in data && "status" in data) {
      envelope = data;
      status = data.status;
      warning = data.warning;
      data = data.ok ? data.data : { code: data.error?.code, error: data.error?.message ?? data.error, hint: data.error?.hint };
    }
    return { ok: !res.isError, data, images, status, warning, envelope, ms: Date.now() - t };
  }
  return { call, req, close: () => p.kill() };
}
