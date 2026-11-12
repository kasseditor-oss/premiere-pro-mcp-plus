import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { BridgeError } from "./bridge.js";

/**
 * Second backend: a UXP plugin inside Premiere (25.6+) connects to this
 * WebSocket server (127.0.0.1 only, token in the URL). The plugin reads the
 * port and the token from <bridgeDir>/uxp.json, written here.
 *
 * Only one MCP server process can own the port; the others report the UXP
 * backend as "owned by another server" and keep retrying in case it exits.
 */
export class UxpConnector {
  readonly port = Number(process.env.PREMIERE_MCP_UXP_PORT || 47653);
  readonly token = process.env.PREMIERE_MCP_UXP_TOKEN || randomBytes(16).toString("hex");
  private wss: WebSocketServer | null = null;
  private sock: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
  private probeData: any = null;
  state: "off" | "listening" | "connected" | "port_in_use" | "disabled" = "off";
  connectedAt = 0;

  constructor(private dir: string) {
    if (process.env.PREMIERE_MCP_UXP === "0") {
      this.state = "disabled";
      return;
    }
    this.listen();
  }

  private listen() {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });
    wss.on("listening", () => {
      this.wss = wss;
      this.state = "listening";
      try {
        fs.writeFileSync(path.join(this.dir, "uxp.json"), JSON.stringify({ port: this.port, token: this.token, pid: process.pid }), "utf-8");
      } catch {
        /* ignore */
      }
    });
    wss.on("error", (e: any) => {
      if (e?.code === "EADDRINUSE") {
        this.state = "port_in_use";
        try {
          wss.close();
        } catch {
          /* ignore */
        }
        setTimeout(() => this.listen(), 30_000).unref();
      }
    });
    wss.on("connection", (ws, req) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.searchParams.get("token") !== this.token) {
        ws.close(4001, "bad token");
        return;
      }
      try {
        this.sock?.close();
      } catch {
        /* ignore */
      }
      this.sock = ws;
      this.state = "connected";
      this.connectedAt = Date.now();
      this.probeData = null;
      ws.on("message", (raw) => {
        let m: any;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data);
        else p.reject(new BridgeError(m.error?.code || "UXP_ERROR", m.error?.message || "UXP call failed"));
      });
      ws.on("close", () => {
        if (this.sock !== ws) return;
        this.sock = null;
        this.state = this.wss ? "listening" : "off";
        this.probeData = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new BridgeError("UXP_DISCONNECTED", "The UXP plugin disconnected during the call."));
          this.pending.delete(id);
        }
      });
    });
    // Never keep the process alive just for this server.
    (wss as any)._server?.unref?.();
  }

  get connected(): boolean {
    return !!this.sock && this.sock.readyState === 1;
  }

  call<T = any>(fn: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.connected) return Promise.reject(new BridgeError("UXP_NOT_CONNECTED", "The UXP plugin is not connected.", "Install it with --install-uxp and restart Premiere (25.6+)."));
    const id = `u${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("UXP_TIMEOUT", `UXP call '${fn}' did not answer within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock!.send(JSON.stringify({ id, fn, args }));
    });
  }

  /** API surface reported by the plugin (cached per connection). */
  async probe(): Promise<any | null> {
    if (!this.connected) return null;
    if (!this.probeData) this.probeData = await this.call("probe", {}, 15_000).catch(() => null);
    return this.probeData;
  }

  dispose() {
    try {
      this.wss?.close();
    } catch {
      /* ignore */
    }
  }
}
