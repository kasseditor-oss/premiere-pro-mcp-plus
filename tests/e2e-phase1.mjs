// Phase 1 (architecture) live tests: envelope, project guard, checkpoints/diff,
// confirmation tokens, jobs, bridge_stats, permission profiles, tool packs, UXP.
// Usage: node tests/e2e-phase1.mjs [mediaDir]
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { connect } from "./mcp-client.mjs";
import { near, suite } from "./harness.mjs";

const DIR = path.resolve(process.argv[2] || "D:/mcp-plus-e2e");
const T = await suite("phase1", DIR);
const { c, ctx, step, expectError, record } = T;

await step("envelope on a read tool", "premiere_status", {}, (d, r) => r.envelope?.ok === true && r.envelope.tool === "premiere_status" && r.status === "ok" && "status ok");
await T.setup();
await step("place 12 clips on V1", "place_clips", () => ({ clips: Array.from({ length: 12 }, (_, i) => ({ item: ctx["clipA.mp4"], track: "V1", start: i * 1, in: i % 5, out: (i % 5) + 1, media: "video" })) }), (d) => d.placed.length === 12);

// ---- project guard
await expectError("expected_project_path mismatch", "get_timeline", { expected_project_path: "D:/nao/existe.prproj" }, "PROJECT_MISMATCH");
await step("expected_project_path match", "get_timeline", () => ({ expected_project_path: ctx.projectPath, compact: true }), (d) => d.tracks.length >= 1);
await expectError("write refused on mismatch", "markers", { action: "add", markers: [{ time: 1 }], expected_project_path: "D:/outro.prproj" }, "PROJECT_MISMATCH");
await step("refused write left no marker", "markers", { action: "list" }, (d) => (d.markers || []).length === 0 && "0 markers");

// ---- envelope status on writes
await step("write status is reported", "markers", { action: "add", markers: [{ time: 2, name: "m" }] }, (d, r) => ["verified", "committed_unverified"].includes(r.status) && r.status);

// ---- checkpoints and diff
await step("checkpoint create", "checkpoint", { action: "create", label: "t1" }, (d) => (ctx.cp = d.checkpoint) && (ctx.cloneName = d.clone?.name) && d.clips === 12 && d.clone.name);
await step("clone exists in the project", "list_sequences", {}, (d) => (d.sequences || d).some((s) => /\[checkpoint/.test(s.name)) && "found");
await step("move one clip +20 s", "edit_clips", () => ({ action: "move", clips: { tracks: ["V1"], limit: 1 }, delta: 20 }), () => true);
await step("remove the last clip", "remove_clips", { clips: { tracks: ["V1"], start_min: 11, start_max: 11 } }, () => true);
await step("diff checkpoint -> now", "checkpoint", () => ({ action: "diff", from: ctx.cp }), (d) => d.summary.moved === 1 && d.summary.removed === 1 && d.summary.added === 0 && JSON.stringify(d.summary));
await step("diff two sequences (clone vs now)", "checkpoint", () => ({ action: "diff", from: ctx.cloneName, to: "S1" }), (d) => d.summary.moved === 1 && d.summary.removed === 1 && JSON.stringify(d.summary));
await step("checkpoint: true on razor", "razor", { times: [3.5], tracks: ["V1"], checkpoint: true }, (d) => d.checkpoint?.clone && d.cuts === 1 && d.checkpoint.clone.name);
await step("restore checkpoint", "checkpoint", () => ({ action: "restore", checkpoint_id: ctx.cp }), async (d) => {
  const tlr = await T.tl({ sequence: d.restored.id, compact: true });
  const n = tlr.tracks.reduce((x, t) => x + t.clips.length, 0);
  return n === 12 && `${d.restored.name}: ${n} clips`;
});
await step("restore left the original active", "open_sequence", { sequence: "S1" }, (d) => d.name === "S1");

// ---- jobs
const wav = path.join(DIR, "talk.wav");
const j1 = await step("analyze_media async -> job", "analyze_media", { action: "silence", file: wav, async: true }, (d, r) => r.status === "queued" && (ctx.job = d.job_id));
await step("jobs wait -> done", "jobs", () => ({ action: "wait", job_id: ctx.job, timeout_s: 120 }), (d) => d.state === "done" && d.result.count >= 0 && `${d.elapsedMs} ms, ${d.result.count} silences`);
const out = path.join(os.tmpdir(), "premiere-mcp-plus-e2e", `job-${Date.now()}.mp4`);
await step("export_sequence async -> job", "export_sequence", { output: out, async: true }, (d) => (ctx.job2 = d.job_id));
await step("jobs status while running", "jobs", () => ({ action: "status", job_id: ctx.job2 }), (d) => ["running", "done"].includes(d.state) && d.state);
await step("jobs wait export -> file verified", "jobs", () => ({ action: "wait", job_id: ctx.job2, timeout_s: 600 }), async (d) => { const len = (await T.tl({ compact: true })).duration; return d.state === "done" && fs.existsSync(d.result.path) && near(d.result.duration, len, 0.2) && `${d.result.duration}s (sequence ${len}s) ${d.result.bytes} bytes`; });
await expectError("jobs unknown id", "jobs", { action: "status", job_id: "job_nope" }, "JOB_NOT_FOUND");
await step("jobs list", "jobs", { action: "list" }, (d) => d.jobs.length >= 2);

// ---- bridge_stats
await step("bridge_stats", "bridge_stats", {}, (d) => d.functions.some((f) => f.fn === "place_clips") && d.queueDepth >= 0 && `${d.functions.length} fns, top ${d.functions[0].fn} avg ${d.functions[0].avgMs} ms`);

// ---- confirmation tokens (server with tokens on)
{
  const k = await connect({ PREMIERE_MCP_CONFIRM: "1" });
  const sel = { tracks: ["V1"] };
  const p = await k.call("remove_clips", { clips: sel, ripple: true });
  record("ripple remove >=10 clips needs confirmation", p.ok && p.status === "needs_confirmation" && !!p.data.confirm_token, JSON.stringify(p.data.preview || p.data).slice(0, 120));
  const n0 = (await T.clipsOn("V1")).length;
  record("preview changed nothing", n0 >= 12, `${n0} clips`);
  const bad = await k.call("remove_clips", { clips: { tracks: ["V2"] }, ripple: true, confirm_token: p.data.confirm_token });
  record("token with other args -> CONFIRMATION_MISMATCH", !bad.ok && bad.data.code === "CONFIRMATION_MISMATCH", bad.data.code);
  const p2 = await k.call("remove_clips", { clips: sel, ripple: true });
  const ok = await k.call("remove_clips", { clips: sel, ripple: true, confirm_token: p2.data.confirm_token });
  const n1 = (await T.clipsOn("V1")).length;
  record("confirmed ripple remove ran", ok.ok && n1 === 0, `${n1} clips left`);
  const again = await k.call("remove_clips", { clips: sel, ripple: true, confirm_token: p2.data.confirm_token });
  record("token is single use", !again.ok && again.data.code === "CONFIRMATION_INVALID", again.data.code);
  const d1 = await k.call("manage_sequence", { action: "delete", sequence: "S1 (restored)" });
  record("delete sequence needs confirmation", d1.ok && d1.status === "needs_confirmation" && d1.data.preview.sequence.name === "S1 (restored)", d1.status);
  const d2 = await k.call("manage_sequence", { action: "delete", sequence: "S1 (restored)", confirm_token: d1.data.confirm_token });
  const seqs = (await c.call("list_sequences", {})).data;
  record("confirmed delete removed it", d2.ok && !(seqs.sequences || seqs).some((s) => s.name === "S1 (restored)"), d2.status);
  k.close();
}

// ---- permission profiles and packs
{
  const k = await connect({ PREMIERE_MCP_PROFILES: "inspect" });
  const list = (await k.req("tools/list", {})).result.tools.map((t) => t.name);
  record("profile inspect: no write tools", list.includes("get_timeline") && !list.includes("place_clips") && !list.includes("run_extendscript"), `${list.length} tools`);
  const b = await k.call("batch", { ops: [{ fn: "add_markers", args: { markers: [{ time: 1 }] } }] });
  record("profile inspect: batch host op denied", !b.ok || b.data.results?.[0]?.code === "PERMISSION_DENIED", JSON.stringify(b.data.results?.[0] || b.data).slice(0, 100));
  k.close();
  const k2 = await connect({ PREMIERE_MCP_PROFILES: "" });
  const l2 = (await k2.req("tools/list", {})).result.tools.map((t) => t.name);
  record("default profiles: no run_extendscript", !l2.includes("run_extendscript") && l2.includes("place_clips"), `${l2.length} tools`);
  k2.close();
  const k3 = await connect({ PREMIERE_MCP_PACK: "essential" });
  const r3 = (await k3.req("tools/list", {})).result;
  const bytes = JSON.stringify(r3).length;
  record("pack essential", r3.tools.length <= 26 && r3.tools.some((t) => t.name === "place_clips"), `${r3.tools.length} tools, ${bytes} bytes`);
  ctx.essentialBytes = bytes;
  k3.close();
}

// ---- UXP backend
{
  const st = (await c.call("premiere_status", {})).data;
  const u = st.backends?.uxp;
  if (u?.state === "connected") {
    const r = await c.call("run_extendscript", { backend: "uxp", code: "return (await ppro.Project.getActiveProject()).name" });
    record("UXP backend answers", r.ok && typeof r.data.result === "string", JSON.stringify(r.data).slice(0, 100));
  } else if (u?.state === "port_in_use") console.log("      (UXP port owned by another MCP server process: UXP checked through that server)");
  else record("UXP backend connected", false, `state ${u?.state} (restart Premiere after --install-uxp)`);
}

await T.finish();
