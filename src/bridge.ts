import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_CLOSE, DialogWatcher, PROGRESS, type PremiereDialog } from "./dialogs.js";
import { UxpConnector } from "./uxp.js";

/** Per-function timing kept by the bridge (bridge_stats). */
interface FnStat {
  calls: number;
  errors: number;
  totalMs: number;
  hostMs: number;
  maxMs: number;
  lastMs: number;
}

/** Error raised for anything the host reported or the bridge detected. */
export class BridgeError extends Error {
  constructor(public code: string, message: string, public hint?: string) {
    super(message);
  }
}

export interface CallOptions {
  timeoutMs?: number;
}

const HEARTBEAT_STALE_MS = 4000;

export function bridgeDir(): string {
  const configured = process.env.PREMIERE_MCP_PLUS_DIR?.trim();
  return configured || path.join(os.tmpdir(), "premiere-mcp-plus");
}

const here = path.dirname(fileURLToPath(import.meta.url));
export function packageRoot(): string {
  // dist/bridge.js -> package root
  return path.resolve(here, "..");
}

/**
 * File-based JSON-RPC bridge to the CEP panel running inside Premiere Pro.
 * Commands are serialized (Premiere's ExtendScript engine is single-threaded
 * and stateful) and woken by fs.watch instead of fixed-interval polling.
 */
export class PremiereBridge {
  readonly dir = bridgeDir();
  private libPath = "";
  private libVersion = "";
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  /** Watches for modal Premiere dialogs while a call is waiting (Windows). */
  readonly dialogs = new DialogWatcher();
  /** UXP backend (WebSocket server the UXP plugin connects to). */
  readonly uxp: UxpConnector;
  readonly stats = new Map<string, FnStat>();
  readonly recentErrors: { at: string; fn: string; code: string; message: string }[] = [];
  readonly startedAt = Date.now();
  private waiting = 0;
  /** Open projects counted by the last host call (0 = unknown). */
  openProjects = 0;

  constructor() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.uxp = new UxpConnector(this.dir);
    this.publishLibrary();
    this.cleanupStale();
    this.dialogs.warm();
  }

  /** Copy the host library into the bridge directory, stamped with its content hash. */
  publishLibrary(): void {
    const src = path.join(packageRoot(), "host", "premiere-lib.jsx");
    const raw = fs.readFileSync(src, "utf-8");
    const version = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    const body = raw.replace("__LIB_VERSION__", version);
    const dest = path.join(this.dir, `premiere-lib-${version}.jsx`);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, body, "utf-8");
    this.libPath = dest;
    this.libVersion = version;
  }

  get library() {
    return { path: this.libPath, version: this.libVersion };
  }

  private cleanupStale(): void {
    const now = Date.now();
    for (const f of safeReaddir(this.dir)) {
      const full = path.join(this.dir, f);
      try {
        const st = fs.statSync(full);
        const old = now - st.mtimeMs > 10 * 60 * 1000;
        if (/^res_/.test(f) && old) fs.unlinkSync(full);
        if (/^premiere-lib-/.test(f) && full !== this.libPath && old) fs.unlinkSync(full);
        if (/\.(staged|claimed)$/.test(f) && old) fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  }

  heartbeat(): { alive: boolean; ageMs: number | null; busy: { id: string; fn: string; since: number } | null; lib?: string; count?: number } {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, "heartbeat.json"), "utf-8"));
      const age = Date.now() - Number(raw.ts || 0);
      return { alive: age < HEARTBEAT_STALE_MS, ageMs: age, busy: raw.busy ?? null, lib: raw.lib, count: raw.count };
    } catch {
      return { alive: false, ageMs: null, busy: null };
    }
  }

  /** Call a host-library function. Calls are queued so only one runs at a time. */
  call<T = any>(fn: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    this.waiting++;
    const run = async () => {
      this.waiting--;
      const t0 = Date.now();
      const st = this.stats.get(fn) || { calls: 0, errors: 0, totalMs: 0, hostMs: 0, maxMs: 0, lastMs: 0 };
      this.stats.set(fn, st);
      try {
        const r = await this.callNow<T>(fn, args, opts, st);
        return r;
      } catch (e: any) {
        st.errors++;
        this.recentErrors.push({ at: new Date().toISOString(), fn, code: e?.code || "ERROR", message: String(e?.message || e).slice(0, 300) });
        if (this.recentErrors.length > 20) this.recentErrors.shift();
        throw e;
      } finally {
        const ms = Date.now() - t0;
        st.calls++;
        st.totalMs += ms;
        st.lastMs = ms;
        if (ms > st.maxMs) st.maxMs = ms;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Calls queued behind the one running now. */
  get queueDepth(): number {
    return this.waiting;
  }

  private async callNow<T>(fn: string, args: Record<string, unknown>, opts: CallOptions, st?: FnStat): Promise<T> {
    const hb = this.heartbeat();
    if (!hb.alive) {
      // Give a just-launched Premiere a moment before failing.
      const ok = await this.waitForHeartbeat(3000);
      if (!ok) {
        throw new BridgeError(
          "PREMIERE_NOT_CONNECTED",
          hb.ageMs === null
            ? "The Premiere MCP Plus panel has never connected. Is Premiere Pro running with the extension installed?"
            : `The Premiere MCP Plus panel stopped responding ${Math.round(hb.ageMs / 1000)}s ago (Premiere closed or frozen?).`,
          "Open Premiere Pro. If it is open, run `premiere-pro-mcp-plus --install-cep`, restart Premiere, and open Window > Extensions > Premiere MCP Plus once.",
        );
      }
    }
    const id = `${Date.now().toString(36)}_${(++this.seq).toString(36)}_${randomBytes(3).toString("hex")}`;
    const cmdFile = path.join(this.dir, `cmd_${id}.json`);
    const resFile = path.join(this.dir, `res_${id}.json`);
    const staged = cmdFile + ".staged";
    fs.writeFileSync(staged, JSON.stringify({ id, fn, args, lib: this.library }), "utf-8");
    fs.renameSync(staged, cmdFile);

    const timeoutMs = opts.timeoutMs ?? 90_000;
    const closed: PremiereDialog[] = [];
    const text = await this.waitForFile(resFile, cmdFile, timeoutMs, fn, closed);
    try {
      fs.unlinkSync(resFile);
    } catch {
      /* ignore */
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BridgeError("BAD_RESPONSE", `Unreadable response from Premiere: ${text.slice(0, 200)}`);
    }
    if (st && typeof parsed.ms === "number") st.hostMs += parsed.ms;
    if (typeof parsed.np === "number") this.openProjects = parsed.np;
    if (!parsed.ok) {
      const e = parsed.error || {};
      throw new BridgeError(e.code || "HOST_ERROR", e.message || "Premiere reported an error", e.hint);
    }
    const data = parsed.data;
    // Informational dialogs (AAF Export Log...) were closed automatically: report them.
    if (closed.length && data && typeof data === "object" && !Array.isArray(data)) (data as any).dialogsClosed = closed.map((d) => ({ title: d.title, text: d.text }));
    return data as T;
  }

  /** Modal dialogs Premiere shows right now. */
  openDialogs(): Promise<PremiereDialog[]> {
    return this.dialogs.list();
  }

  private waitForHeartbeat(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const tick = () => {
        if (this.heartbeat().alive) return resolve(true);
        if (Date.now() > end) return resolve(false);
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  private waitForFile(resFile: string, cmdFile: string, timeoutMs: number, fn: string, closed: PremiereDialog[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      let done = false;
      let watcher: fs.FSWatcher | null = null;
      const started = Date.now();
      let checking = false;
      // A dialog must stay open this long before it is reported (progress
      // windows come and go; a question waits for a click).
      const firstSeen = new Map<string, number>();
      // A modal dialog blocks ExtendScript until someone clicks it. Check every
      // 2 s: dismiss known informational logs, report anything else at once
      // instead of waiting for the timeout.
      const dialogPoll = setInterval(async () => {
        if (done || checking || Date.now() - started < 1500) return;
        checking = true;
        try {
          const list = await this.dialogs.list();
          for (const d of list) {
            if (done) break;
            if (AUTO_CLOSE.some((re) => re.test(d.title))) {
              await this.dialogs.close(d);
              closed.push(d);
            } else if (PROGRESS.some((re) => re.test(d.title))) {
              continue;
            } else {
              const key = d.hwnd + "|" + d.title;
              if (!firstSeen.has(key)) firstSeen.set(key, Date.now());
              if (Date.now() - firstSeen.get(key)! < 6000) continue;
              finish(
                new BridgeError(
                  "PREMIERE_DIALOG",
                  `Premiere is showing a dialog "${d.title}"${d.text ? `: ${d.text.slice(0, 600)}` : ""}. '${fn}' will finish once it is closed.`,
                  "Answer the dialog in Premiere, then check the result (e.g. get_timeline) before retrying.",
                ),
              );
            }
          }
        } catch {
          /* ignore */
        } finally {
          checking = false;
        }
      }, 2000);
      const finish = (err: Error | null, text?: string) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearInterval(dialogPoll);
        watcher?.close();
        if (err) reject(err);
        else resolve(text!);
      };
      const check = () => {
        if (done) return;
        if (fs.existsSync(resFile)) {
          try {
            return finish(null, fs.readFileSync(resFile, "utf-8"));
          } catch {
            /* being renamed; retry */
          }
        }
        const elapsed = Date.now() - started;
        if (elapsed > timeoutMs) {
          const unclaimed = fs.existsSync(cmdFile);
          if (unclaimed) {
            try {
              fs.unlinkSync(cmdFile);
            } catch {
              /* claimed meanwhile */
            }
          }
          const hb = this.heartbeat();
          if (unclaimed) {
            return finish(
              new BridgeError(
                hb.busy ? "PREMIERE_BUSY" : "PREMIERE_NOT_RESPONDING",
                hb.busy
                  ? `Premiere is still busy with '${hb.busy.fn}' (for ${Math.round((Date.now() - hb.busy.since) / 1000)}s); '${fn}' was not run.`
                  : `The panel did not pick up '${fn}' within ${Math.round(timeoutMs / 1000)}s. Nothing was changed.`,
                "Check Premiere for an open dialog, then retry.",
              ),
            );
          }
          return finish(
            new BridgeError(
              "TIMEOUT",
              `'${fn}' started in Premiere but did not finish within ${Math.round(timeoutMs / 1000)}s. It may still complete; inspect the timeline before retrying.`,
              "Long exports should use use_media_encoder: true.",
            ),
          );
        }
        // Fail fast when the panel died mid-command.
        if (elapsed > 5000) {
          const hb = this.heartbeat();
          if (!hb.alive && hb.ageMs !== null && hb.ageMs > 15_000) {
            return finish(new BridgeError("PREMIERE_DISCONNECTED", `Premiere stopped responding while running '${fn}'.`));
          }
        }
      };
      try {
        watcher = fs.watch(this.dir, (_evt, name) => {
          if (name && String(name).startsWith("res_")) check();
        });
        watcher.on("error", () => undefined);
      } catch {
        watcher = null;
      }
      const poll = setInterval(check, 150);
      check();
    });
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
