import { randomBytes } from "node:crypto";
import { BridgeError } from "./bridge.js";
/**
 * Background jobs for long operations (export, analysis, transcription...).
 * A tool called with async: true returns {job_id} at once; jobs status/wait
 * report progress, ETA, result or error. Premiere calls inside a job still go
 * through the single bridge queue, so other Premiere calls wait behind them;
 * FFmpeg/analysis work runs in parallel.
 */
export class JobManager {
    jobs = new Map();
    start(tool, run) {
        const id = "job_" + randomBytes(4).toString("hex");
        const job = { id, tool, state: "running", startedAt: Date.now(), cancelRequested: false, done: Promise.resolve() };
        const ctx = {
            progress: (p, note) => {
                job.progress = Math.max(0, Math.min(1, p));
                if (note)
                    job.note = note;
            },
            get cancelled() {
                return job.cancelRequested;
            },
        };
        job.done = run(ctx).then((r) => {
            job.state = job.cancelRequested ? "cancelled" : "done";
            job.result = r;
            job.progress = 1;
            job.endedAt = Date.now();
        }, (e) => {
            job.state = job.cancelRequested ? "cancelled" : "failed";
            job.error = { code: e?.code || "JOB_FAILED", message: String(e?.message || e), hint: e?.hint };
            job.endedAt = Date.now();
        });
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
    get(id) {
        const j = this.jobs.get(id);
        if (!j)
            throw new BridgeError("JOB_NOT_FOUND", `No job ${id}.`, "jobs action 'list' shows the known jobs.");
        return j;
    }
    status(id, withResult = true) {
        const j = this.get(id);
        const elapsed = (j.endedAt || Date.now()) - j.startedAt;
        const out = { job_id: j.id, tool: j.tool, state: j.state, elapsedMs: elapsed };
        if (j.progress !== undefined)
            out.progress = Math.round(j.progress * 1000) / 1000;
        if (j.note)
            out.note = j.note;
        if (j.state === "running" && j.progress && j.progress > 0.02)
            out.etaMs = Math.round((elapsed * (1 - j.progress)) / j.progress);
        if (j.error)
            out.error = j.error;
        if (withResult && j.state === "done")
            out.result = j.result;
        return out;
    }
    async wait(id, timeoutMs) {
        const j = this.get(id);
        if (j.state === "running")
            await Promise.race([j.done, new Promise((r) => setTimeout(r, timeoutMs))]);
        const s = this.status(id);
        if (s.state === "running")
            s.waitTimedOut = true;
        return s;
    }
    cancel(id) {
        const j = this.get(id);
        if (j.state === "running")
            j.cancelRequested = true;
        return { ...this.status(id, false), note: "Cancel requested. Work already sent to Premiere finishes; loops stop at the next step." };
    }
    list() {
        return [...this.jobs.values()].reverse().map((j) => this.status(j.id, false));
    }
}
