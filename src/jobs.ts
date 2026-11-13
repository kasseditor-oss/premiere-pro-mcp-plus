import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "./bridge.js";

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface JobContext {
  /** Report progress 0..1 (and an optional note). */
  progress(p: number, note?: string): void;
  /** True once job cancel was requested; long loops should stop. */
  readonly cancelled: boolean;
}

interface Job {
  id: string;
  tool: string;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  progress?: number;
  note?: string;
  result?: unknown;
  error?: { code: string; message: string; hint?: string };
  cancelRequested: boolean;
  done: Promise<void>;
}

/**
 * Background jobs for long operations (export, analysis, transcription...).
 * A tool called with async: true returns {job_id} at once; jobs status/wait
 * report progress, ETA, result or error. Premiere calls inside a job still go
 * through the single bridge queue, so other Premiere calls wait behind them;
 * FFmpeg/analysis work runs in parallel.
 */
export class JobManager {
  private jobs = new Map<string, Job>();
  /** Folder where each job's status is saved, so another server process (after a restart) can still report it. */
  constructor(private dir?: string) {
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        // Keep the 100 most recent job files.
        const files = fs.readdirSync(dir).filter((f) => /^job_.*\.json$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
        for (const x of files.slice(100)) fs.rmSync(path.join(dir, x.f), { force: true });
      } catch {
        this.dir = undefined;
      }
    }
  }
  private save(j: Job) {
    if (!this.dir) return;
    try {
      let text = JSON.stringify({ ...this.status(j.id, true), pid: process.pid, startedAt: j.startedAt });
      if (text.length > 2_000_000) text = JSON.stringify({ ...this.status(j.id, false), pid: process.pid, startedAt: j.startedAt, resultTooLarge: true });
      fs.writeFileSync(path.join(this.dir, j.id + ".json"), text, "utf-8");
    } catch {
      /* status on disk is best effort */
    }
  }
  /** A job saved by another server process (e.g. before a restart). */
  private fromDisk(id: string): any | null {
    if (!this.dir || !/^job_[0-9a-f]+$/.test(id)) return null;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(this.dir, id + ".json"), "utf-8"));
      if (d.state === "running" && d.pid !== process.pid) {
        let alive = false;
        try {
          process.kill(d.pid, 0);
          alive = true;
        } catch {
          /* gone */
        }
        if (!alive) Object.assign(d, { state: "lost", note: "The server process that ran this job stopped before it finished (Claude or the server restarted). Check Premiere and run it again if needed." });
        else d.note = "Running in another server process.";
      }
      d.fromDisk = true;
      return d;
    } catch {
      return null;
    }
  }

  start(tool: string, run: (ctx: JobContext) => Promise<unknown>): string {
    const id = "job_" + randomBytes(4).toString("hex");
    const job: Job = { id, tool, state: "running", startedAt: Date.now(), cancelRequested: false, done: Promise.resolve() };
    const ctx: JobContext = {
      progress: (p, note) => {
        job.progress = Math.max(0, Math.min(1, p));
        if (note) job.note = note;
      },
      get cancelled() {
        return job.cancelRequested;
      },
    };
    job.done = run(ctx).then(
      (r) => {
        job.state = job.cancelRequested ? "cancelled" : "done";
        job.result = r;
        job.progress = 1;
        job.endedAt = Date.now();
        this.save(job);
      },
      (e: any) => {
        job.state = job.cancelRequested ? "cancelled" : "failed";
        job.error = { code: e?.code || "JOB_FAILED", message: String(e?.message || e), hint: e?.hint };
        job.endedAt = Date.now();
        this.save(job);
      },
    );
    this.jobs.set(id, job);
    this.save(job);
    // Keep the 50 most recent jobs.
    if (this.jobs.size > 50) {
      for (const [k, j] of this.jobs) {
        if (j.state !== "running") {
          this.jobs.delete(k);
          break;
        }
      }
    }
    return id;
  }

  private get(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new BridgeError("JOB_NOT_FOUND", `No job ${id}.`, "jobs action 'list' shows the known jobs.");
    return j;
  }

  status(id: string, withResult = true) {
    if (!this.jobs.has(id)) {
      const d = this.fromDisk(id);
      if (d) {
        if (!withResult) delete d.result;
        return d;
      }
    }
    const j = this.get(id);
    const elapsed = (j.endedAt || Date.now()) - j.startedAt;
    const out: any = { job_id: j.id, tool: j.tool, state: j.state, elapsedMs: elapsed };
    if (j.progress !== undefined) out.progress = Math.round(j.progress * 1000) / 1000;
    if (j.note) out.note = j.note;
    if (j.state === "running" && j.progress && j.progress > 0.02) out.etaMs = Math.round((elapsed * (1 - j.progress)) / j.progress);
    if (j.error) out.error = j.error;
    if (withResult && j.state === "done") out.result = j.result;
    return out;
  }

  async wait(id: string, timeoutMs: number) {
    if (!this.jobs.has(id)) {
      const d = this.fromDisk(id);
      if (d) return d;
    }
    const j = this.get(id);
    if (j.state === "running") await Promise.race([j.done, new Promise((r) => setTimeout(r, timeoutMs))]);
    const s = this.status(id);
    if (s.state === "running") s.waitTimedOut = true;
    return s;
  }

  cancel(id: string) {
    const j = this.get(id);
    if (j.state === "running") j.cancelRequested = true;
    return { ...this.status(id, false), note: "Cancel requested. Work already sent to Premiere finishes; loops stop at the next step." };
  }

  list() {
    const mine = [...this.jobs.values()].reverse().map((j) => this.status(j.id, false));
    if (!this.dir) return mine;
    // Plus jobs of earlier server processes, newest first.
    let other: any[] = [];
    try {
      other = fs
        .readdirSync(this.dir)
        .filter((f) => /^job_[0-9a-f]+\.json$/.test(f) && !this.jobs.has(f.slice(0, -5)))
        .map((f) => this.fromDisk(f.slice(0, -5)))
        .filter(Boolean)
        .map((d) => {
          delete d.result;
          return d;
        })
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, 30);
    } catch {
      /* none */
    }
    return [...mine, ...other];
  }
}
