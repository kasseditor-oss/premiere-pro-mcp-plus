import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { BridgeError, packageRoot } from "./bridge.js";
/**
 * Second backend: a UXP plugin inside Premiere (25.6+) connects to this
 * WebSocket server (127.0.0.1 only, token in the URL). The plugin reads the
 * port and the token from <bridgeDir>/uxp-servers/<pid>.json, written here.
 *
 * Each MCP server process listens on its own port (PREMIERE_MCP_UXP_PORT or a free
 * one) and the plugin connects to all of them.
 */
export class UxpConnector {
    dir;
    port = Number(process.env.PREMIERE_MCP_UXP_PORT || 0);
    token = process.env.PREMIERE_MCP_UXP_TOKEN || randomBytes(16).toString("hex");
    wss = null;
    sock = null;
    seq = 0;
    pending = new Map();
    probeData = null;
    state = "off";
    /** Handlers the plugin loaded (from its "ready" message). */
    handlers = [];
    regFile = "";
    connectedAt = 0;
    constructor(dir) {
        this.dir = dir;
        if (process.env.PREMIERE_MCP_UXP === "0") {
            this.state = "disabled";
            return;
        }
        this.listen();
    }
    listen() {
        const wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });
        wss.on("listening", () => {
            this.wss = wss;
            this.state = "listening";
            this.port = wss.address().port;
            // Register in the folder the UXP loader scans (one file per server process).
            try {
                const reg = path.join(this.dir, "uxp-servers");
                fs.mkdirSync(reg, { recursive: true });
                this.regFile = path.join(reg, `${process.pid}.json`);
                fs.writeFileSync(this.regFile, JSON.stringify({ port: this.port, token: this.token, pid: process.pid }), "utf-8");
                // Drop registrations of processes that are gone.
                for (const f of fs.readdirSync(reg)) {
                    const pid = Number(f.replace(/.json$/, ""));
                    if (pid && pid !== process.pid) {
                        try {
                            process.kill(pid, 0);
                        }
                        catch {
                            fs.rmSync(path.join(reg, f), { force: true });
                        }
                    }
                }
                const cleanup = () => fs.rmSync(this.regFile, { force: true });
                process.once("exit", cleanup);
            }
            catch {
                /* ignore */
            }
        });
        wss.on("error", (e) => {
            if (e?.code === "EADDRINUSE") {
                this.state = "port_in_use";
                try {
                    wss.close();
                }
                catch {
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
            }
            catch {
                /* ignore */
            }
            this.sock = ws;
            this.state = "connected";
            this.connectedAt = Date.now();
            this.probeData = null;
            this.handlers = [];
            // Send the handler code: the plugin is only a loader.
            try {
                const code = fs.readFileSync(path.join(packageRoot(), "uxp", "handlers.js"), "utf-8");
                ws.send(JSON.stringify({ type: "code", code }));
            }
            catch {
                /* ignore */
            }
            ws.on("message", (raw) => {
                let m;
                try {
                    m = JSON.parse(String(raw));
                }
                catch {
                    return;
                }
                if (m.type === "ready") {
                    this.handlers = m.handlers || [];
                    return;
                }
                const p = this.pending.get(m.id);
                if (!p)
                    return;
                this.pending.delete(m.id);
                clearTimeout(p.timer);
                if (m.ok)
                    p.resolve(m.data);
                else
                    p.reject(new BridgeError(m.error?.code || "UXP_ERROR", m.error?.message || "UXP call failed"));
            });
            ws.on("close", () => {
                if (this.sock !== ws)
                    return;
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
        wss._server?.unref?.();
    }
    get connected() {
        return !!this.sock && this.sock.readyState === 1;
    }
    call(fn, args = {}, timeoutMs = 60_000) {
        if (!this.connected)
            return Promise.reject(new BridgeError("UXP_NOT_CONNECTED", "The UXP plugin is not connected.", "Install it with --install-uxp and restart Premiere (25.6+)."));
        const id = `u${++this.seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new BridgeError("UXP_TIMEOUT", `UXP call '${fn}' did not answer within ${Math.round(timeoutMs / 1000)}s.`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.sock.send(JSON.stringify({ id, fn, args }));
        });
    }
    /** API surface reported by the plugin (cached per connection). */
    async probe() {
        if (!this.connected)
            return null;
        if (!this.probeData)
            this.probeData = await this.call("probe", {}, 15_000).catch(() => null);
        return this.probeData;
    }
    dispose() {
        try {
            this.wss?.close();
        }
        catch {
            /* ignore */
        }
    }
}
