// Live checks of the fixes from the v2.5.2 test report (RELATORIO-v2.5.2.md).
// Usage: node tests/e2e-v253.mjs D:/mcp-plus-e2e   (run make-media.mjs first)
// Creates its own project; every call carries expected_project_path.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { suite, near } from "./harness.mjs";
import { connect } from "./mcp-client.mjs";

const DIR = path.resolve(process.argv[2] || "D:/mcp-plus-e2e");
const ff = (...args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args]);
// Speech under loud constant noise (no clear silence) and a VP9-in-MP4 file Premiere cannot decode.
if (!fs.existsSync(path.join(DIR, "noisy.wav")))
  ff("-i", path.join(DIR, "speech.wav"), "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.35:d=30", "-filter_complex", "[0:a]volume=1.0[s];[s][1:a]amix=inputs=2:duration=first:normalize=0", "-ar", "48000", path.join(DIR, "noisy.wav"));
if (!fs.existsSync(path.join(DIR, "vp9.mp4"))) ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=4", "-c:v", "libvpx-vp9", "-b:v", "500k", "-an", path.join(DIR, "vp9.mp4"));

const S = await suite("v253", DIR);
const { c, ctx, step, expectError, record, setup, finish, tl, clipsOn } = S;
const only = (process.env.V253_ONLY || "").split(",").filter(Boolean);
const section = (n) => !only.length || only.includes(n);
const seq = (name) => step(`sequence ${name}`, "create_sequence", { name, width: 1920, height: 1080, fps: 30 }, (d) => d.width === 1920);

await setup({ sequence: false, extra: ["speech.wav", "noisy.wav", "music.wav", "angleA.mp4", "sync_ext.wav"] });

// ---------------------------------------------------------------- bug 3 freeze_frame
if (section("freeze")) {
  await seq("FZ");
  await step("a 0-4, b 4-8 on V1", "place_clips", () => ({ sequence: "FZ", clips: [{ item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 4, media: "video" }, { item: ctx["clipB.mp4"], track: "V1", start: 4, in: 0, out: 4, media: "video" }] }), (d) => d.placed.length === 2 && (ctx.fzB = d.placed[1].id));
  await expectError("freeze at 1 (outside clip b) refused", "edit_clips", () => ({ sequence: "FZ", action: "freeze_frame", clips: ctx.fzB, at: 1, duration: 2 }), "BAD_ARGS");
  await step("freeze offset 1 in clip b", "edit_clips", () => ({ sequence: "FZ", action: "freeze_frame", clips: ctx.fzB, offset: 1, duration: 2 }), async (d, r) => {
    const v = await clipsOn("V1", { sequence: "FZ" });
    const a = v[0];
    const still = v.find((x) => near(x.start, 5) && near(x.end, 7));
    return r.status === "verified" && near(a.start, 0) && near(a.end, 4) && still && v.some((x) => near(x.start, 7) && near(x.end, 10)) && v.map((x) => `${x.start}-${x.end}`).join(" ");
  });
}

// ---------------------------------------------------------------- bug 1 jump_cut on noisy audio + confirmation
if (section("jump_cut")) {
  await seq("JN");
  await step("noisy speech on A1", "place_clips", () => ({ sequence: "JN", clips: [{ item: ctx["noisy.wav"], track: "A1", start: 0, media: "audio" }] }), (d) => d.placed.length === 1);
  await step("jump_cut preview on noise: nothing, warning", "auto_edit", { sequence: "JN", action: "jump_cut", preview: true }, (d, r) => d.count === 0 && /No clear silence/.test(d.warning || r.warning || "") && `thresholds ${d.thresholds}`);

  await seq("JC");
  await step("clean speech on A1", "place_clips", () => ({ sequence: "JC", clips: [{ item: ctx["speech.wav"], track: "A1", start: 0, media: "audio" }] }), (d) => d.placed.length === 1);
  await step("preview returns detail with reasons", "auto_edit", { sequence: "JC", action: "jump_cut", preview: true }, (d) => d.count >= 3 && d.detail?.every((x) => x.reason === "silence") && d.share > 0 && `share ${d.share}`);
  // Confirmation is on by default (the suite client turns it off): a second client with the default.
  const c2 = await connect({ PREMIERE_MCP_CONFIRM: "1" });
  const args = { sequence: "JC", action: "jump_cut", max_cut: 0.05, expected_project_path: ctx.projectPath };
  const before = (await tl({ sequence: "JC", compact: true })).duration;
  const r1 = await c2.call("auto_edit", args);
  record("cut above max_cut asks confirmation", r1.ok && r1.status === "needs_confirmation" && !!r1.data.confirm_token, JSON.stringify(r1.data).slice(0, 160));
  const mid = (await tl({ sequence: "JC", compact: true })).duration;
  record("nothing cut before confirming", near(mid, before), `${before} -> ${mid}`);
  const r2 = await c2.call("auto_edit", { ...args, confirm_token: r1.data.confirm_token });
  const after = (await tl({ sequence: "JC", compact: true })).duration;
  record("confirmed cut applied", r2.ok && r2.status === "verified" && after < before - 1, `${before} -> ${after} (${r2.status})`);
  c2.close();
}

// ---------------------------------------------------------------- bug 4 undecodable media
if (section("media")) {
  // Premiere 26 refuses VP9-in-MP4 with a "File Import Failure" dialog (closed by the server);
  // other builds import it without a frame rate. Either way the answer must warn.
  await step("import VP9 mp4 warns", "import_media", { paths: [path.join(DIR, "vp9.mp4")], bin: "Test" }, (d, r) => {
    ctx.vp9 = d.imported[0]?.id;
    return /refused|frame rate/i.test(d.warning || r.warning || "") && (d.warning || r.warning).slice(0, 120);
  });
  if (ctx.vp9) await step("get_item_info warns", "get_item_info", () => ({ item: ctx.vp9 }), (d) => (ctx.vp9bad = !!d.warning));
  if (ctx.vp9bad) {
    await seq("VP");
    await expectError("place undecodable: UNSUPPORTED_MEDIA", "place_clips", () => ({ sequence: "VP", clips: [{ item: ctx.vp9, track: "V1", start: 0, media: "video" }] }), "UNSUPPORTED_MEDIA");
  } else record("place undecodable (skipped: this Premiere decodes VP9)", true);
}

// ---------------------------------------------------------------- bugs 6, 7 audio / clips required
if (section("audio")) {
  await seq("AU");
  await step("clips on A1..A3", "place_clips", () => ({ sequence: "AU", clips: [{ item: ctx["vo.wav"], track: "A1", start: 0, media: "audio" }, { item: ctx["music.wav"], track: "A2", start: 0, media: "audio" }, { item: ctx["talk.wav"], track: "A3", start: 0, media: "audio" }, { item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 3, media: "video" }] }), (d) => d.placed.length >= 4);
  await expectError("color auto_balance without clips", "color", { sequence: "AU", action: "auto_balance" }, "BAD_ARGS");
  await expectError("audio gain without clips", "audio", { sequence: "AU", action: "gain", db: 3 }, "BAD_ARGS");
  const muted = async () => (await tl({ sequence: "AU" })).tracks.filter((t) => t.track.startsWith("A") && t.muted).map((t) => t.track);
  await step("solo A1", "audio", { sequence: "AU", action: "solo_track", tracks: ["A1"] }, async () => { const m = await muted(); return m.includes("A2") && !m.includes("A1") && m.join(","); });
  await step("unmute track A2", "audio", { sequence: "AU", action: "unmute", tracks: ["A2"] }, async (d, r) => { const m = await muted(); return r.status === "verified" && !m.includes("A2") && m.includes("A3") && `muted ${m.join(",")}`; });
  await step("unsolo", "audio", { sequence: "AU", action: "unsolo" }, async (d, r) => r.status === "verified" && (await muted()).length === 0);
}

// ---------------------------------------------------------------- bugs 8, 10, 13, 14 small ones
if (section("small")) {
  await expectError("transcribe missing file", "transcribe", { file: path.join(DIR, "nao-existe.wav") }, "FILE_NOT_FOUND");
  await step("title with missing font warns", "create_title_image", { lines: [{ text: "Teste" }], font_family: "Fonte Que Nao Existe", output: path.join(DIR, "out", "v253_title.png") }, (d) => /not installed/.test(d.warning || "") && d.title.family === "Arial");
  await step("H.264 presets: mp4 first, container shown", "list_export_presets", { filter: "H.264" }, (d) => d.presets[0].container === "mp4" && `${d.presets[0].name} (${d.presets[0].container})`);
  const st = (await c.call("premiere_status", {})).data;
  if (st.backends?.uxp?.state === "connected") await step("run_extendscript backend uxp", "run_extendscript", { backend: "uxp", code: "return (await ppro.Project.getActiveProject()).name" }, (d) => typeof d.result === "string" && d.result);
  else await expectError("run_extendscript uxp without plugin", "run_extendscript", { backend: "uxp", code: "return 1" }, "UXP_NOT_CONNECTED");
}

// ---------------------------------------------------------------- bug 11 sync_audio picks a free track
if (section("sync")) {
  await seq("SY");
  await step("camera A1 + music A2", "place_clips", () => ({ sequence: "SY", clips: [{ item: ctx["angleA.mp4"], track: "V1", start: 0, media: "both" }, { item: ctx["music.wav"], track: "A2", start: 0, media: "audio" }] }), (d) => d.placed.length >= 2);
  const tracksBefore = (await tl({ sequence: "SY", compact: true })).tracks.filter((t) => t.track.startsWith("A")).length;
  await step("sync_audio lands on A3", "auto_edit", { sequence: "SY", action: "sync_audio", file: path.join(DIR, "sync_ext.wav") }, async (d) => {
    const tracksAfter = (await tl({ sequence: "SY", compact: true })).tracks.filter((t) => t.track.startsWith("A")).length;
    return d.placed?.track === "A3" && tracksAfter <= Math.max(tracksBefore, 3) && `offset ${d.offset}, ${tracksBefore} -> ${tracksAfter} audio tracks`;
  });
}

// ---------------------------------------------------------------- bug 5 mix writes the file
if (section("mix")) {
  await seq("MX");
  await step("voice A1 + music A2", "place_clips", () => ({ sequence: "MX", clips: [{ item: ctx["speech.wav"], track: "A1", start: 0, media: "audio" }, { item: ctx["music.wav"], track: "A2", start: 0, media: "audio" }] }), (d) => d.placed.length === 2);
  const out = path.join(DIR, "out", "v253-mix");
  await step("mix with folder keeps the file", "auto_edit", { sequence: "MX", action: "mix", folder: out }, (d) => d.file && fs.existsSync(d.file) && path.dirname(d.file) === out && `${path.basename(d.file)} ${d.after?.lufs} LUFS`);
}

// ---------------------------------------------------------------- bug 16 recipe skip reason
if (section("recipe")) {
  await step("save tiny recipe", "recipes", { action: "save", name: "v253_test", params: { output_folder: "" }, steps: [{ tool: "premiere_status" }, { tool: "deliver", args: { action: "export", platform: "youtube", folder: "{{output_folder}}" }, when: "output_folder" }] }, (d) => !!d);
  await step("run: skip reason + unknown param", "recipes", { action: "run", name: "v253_test", params: { folder: "x" } }, (d) => d.results[1].skipped && /output_folder/.test(d.results[1].reason) && /folder/.test(d.warning || "") && d.results[1].reason);
  await step("delete recipe", "recipes", { action: "delete", name: "v253_test" }, (d) => !!d);
}

// ---------------------------------------------------------------- bug 15 jobs survive a server restart
if (section("jobs")) {
  const r = await c.call("transcribe", { file: path.join(DIR, "speech.wav"), model: "tiny", language: "en", async: true });
  const id = r.data?.job_id;
  await step("job finishes", "jobs", { action: "wait", job_id: id, timeout_s: 300 }, (d) => d.state === "done");
  const c3 = await connect({});
  const s = await c3.call("jobs", { action: "status", job_id: id });
  record("other server process sees the job", s.ok && s.data.state === "done" && s.data.fromDisk === true, JSON.stringify(s.data).slice(0, 120));
  c3.close();
}

// ---------------------------------------------------------------- bug 9 stabilize status
if (section("stabilize")) {
  await seq("ST");
  await step("clip for stabilize", "place_clips", () => ({ sequence: "ST", clips: [{ item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 2, media: "video" }] }), (d) => (ctx.stId = d.placed[0]?.id));
  await expectError("stabilize without clips", "stabilize", { sequence: "ST" }, "BAD_ARGS");
  await step("stabilize: no false 'done'", "stabilize", () => ({ sequence: "ST", clips: ctx.stId, grace_s: 8, timeout_s: 180 }), (d, r) => (r.status === "committed_unverified" || (r.status === "verified" && d.seconds >= 1)) && `${r.status}, ${d.seconds}s`);
}

await finish();
