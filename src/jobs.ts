import { randomBytes } from "node:crypto";
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
      },
      (e: any) => {
        job.state = job.cancelRequested ? "cancelled" : "failed";
        job.error = { code: e?.code || "JOB_FAILED", message: String(e?.message || e), hint: e?.hint };
        job.endedAt = Date.now();
      },
    );
    this.jobs.set(id, job);
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
    return [...this.jobs.values()].reverse().map((j) => this.status(j.id, false));
  }
}
