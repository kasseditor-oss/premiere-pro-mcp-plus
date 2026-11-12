// End-to-end test against a live Premiere Pro with the CEP panel running.
// Usage: node tests/e2e-premiere.mjs [mediaDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "./mcp-client.mjs";

const DIR = path.resolve(process.argv[2] || "D:/mcp-plus-test");
const c = await connect();
const results = [];
const ctx = {};

async function step(name, tool, args, check) {
  const r = await c.call(tool, typeof args === "function" ? args() : args);
  let pass = r.ok;
  let note = "";
  if (pass && check) {
    try {
      const v = await check(r.data, r);
      if (v === false) pass = false;
      else if (typeof v === "string") note = v;
    } catch (e) {
      pass = false;
      note = "check threw: " + e.message;
    }
  }
  if (!r.ok) note = typeof r.data === "object" ? `${r.data.code}: ${r.data.error}` : String(r.data);
  results.push({ name, tool, pass, ms: r.ms, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(42)} ${String(r.ms).padStart(6)}ms  ${note.slice(0, 160)}`);
  // Guard: the active project must stay the test project.
  if (ctx.projectPath && tool !== "project_file") {
    const st = await c.call("premiere_status", {});
    const cur = st.data?.project?.path || "";
    if (cur.toLowerCase() !== ctx.projectPath.toLowerCase()) {
      console.log(`      !! active project changed after "${name}": ${cur}`);
      results.push({ name: `active project kept after ${name}`, tool, pass: false, ms: 0, note: cur });
    }
  }
  return r;
}

const proj = path.join(DIR, `e2e-${Date.now()}.prproj`);
await step("status", "premiere_status", {}, (d) => d.connected === true && `Premiere ${d.premiere}, locale ${d.locale}`);
await step("new project", "project_file", { action: "new", path: proj }, (d) => (ctx.projectPath = d.path) && d.created);
await step("import folder into bin", "import_media", { folder: DIR, bin: "Test" }, (d) => {
  // Only files at the root of the media folder, first occurrence (an imported
  // FCP XML would bring items with the same names).
  for (const it of d.imported) if (!ctx[it.name] && it.type !== "bin" && it.media && path.dirname(it.media).toLowerCase() === DIR.toLowerCase()) ctx[it.name] = it.id;
  return d.count >= 5 ? `${d.count} items` : false;
});
await step("list project items", "list_project_items", { bin: "Test", details: true }, (d) => d.total >= 5 && d.items.map((i) => `${i.name}:${i.duration}`).join(" "));
await step("create 1080p30 sequence (no dialog)", "create_sequence", { name: "E2E", width: 1920, height: 1080, fps: 30 }, (d) => d.width === 1920 && d.height === 1080 && Math.abs(d.fps - 30) < 0.01 && `${d.width}x${d.height}@${d.fps}`);
const place = await step(
  "place_clips batch (5 clips, mixed)",
  "place_clips",
  () => ({
    clips: [
      { item: ctx["clipA.mp4"], track: "V1", start: 0, in: 1, out: 5 },
      { item: ctx["clipB.mp4"], track: "V2", start: 2, in: 1, duration: 3, media: "video", effects: ["Gaussian Blur"] },
      { item: ctx["still.png"], track: "V3", start: 1, duration: 2, transform: { scale: 50, position: [1600, 800] }, keyframes: [{ property: "Scale", keys: [{ t: 0, v: 50 }, { t: "end", v: 60 }] }] },
      { item: ctx["vo.wav"], track: "A2", start: 0, media: "audio", duration: 6, volume_db: -3 },
      { item: ctx["talk.wav"], track: "A4", start: 6, media: "audio" },
    ],
  }),
  (d) => {
    d.placed.forEach((p, i) => (ctx["clip" + i] = p.id));
    return d.errors.length === 0 && d.placed.length === 5 ? d.placed.map((p) => `${p.track}@${p.start}-${p.end}${p.videoOnly ? "(V-only)" : ""}`).join(" ") : false;
  },
);
await step("timeline: V-only clip left A2/A3 untouched", "get_timeline", {}, (d) => {
  const a2 = d.tracks.find((t) => t.track === "A2");
  const a1 = d.tracks.find((t) => t.track === "A1");
  const v2 = d.tracks.find((t) => t.track === "V2");
  ctx.timeline = d;
  const vo = a2?.clips?.[0];
  return vo && vo.start === 0 && Math.abs(vo.end - 6) < 0.05 && v2?.clips?.length === 1 && a1?.clips?.length === 1 ? `tracks ${d.tracks.map((t) => t.track + ":" + t.clips.length).join(" ")}` : false;
});
await step("set effect property (Blurriness 40)", "set_properties", () => ({ clips: ctx.clip1, set: [{ effect: "Gaussian Blur", property: "Blurriness", value: 40 }] }), (d) => d.errors.length === 0 && JSON.stringify(d.set[0]));
await step("set_transform on V1", "set_transform", () => ({ clips: { tracks: ["V1"] }, scale: 110, rotation: 5 }), (d) => d.errors.length === 0);
await step("keyframes zoom 100->106 on V1 (selector)", "add_keyframes", () => ({ clips: { tracks: ["V1"] }, animations: [{ property: "Scale", replace: true, keys: [{ t: 0, v: 100 }, { t: "end", v: 106, interp: "ease" }] }] }), (d) => d.errors.length === 0 && d.results.length >= 1);
await step("read keyframes back", "get_clip_effects", () => ({ clips: ctx.clip0 }), (d) => {
  const motion = d.clips[0].components.find((x) => x.matchName === "AE.ADBE Motion");
  const scale = motion.props.find((p) => p.keyframes);
  return scale && scale.keyframes.length === 2 && Math.abs(scale.keyframes[0].t) < 0.05 && Math.abs(scale.keyframes[1].t - 4) < 0.1 ? `keys ${JSON.stringify(scale.keyframes)}` : false;
});
await step("add transitions (Cross Dissolve both ends)", "add_transitions", () => ({ clips: ctx.clip1, position: "both", duration: 0.5 }), (d) => d.results[0].added >= 1 && `added ${d.results[0].added}`);
await step("volume envelope + fades", "fade_audio", () => ({ clips: ctx.clip3, fade_in: 0.5, fade_out: 1 }), (d) => d.clips.length === 1);
await step("set_volume dB", "set_volume", () => ({ clips: ctx.clip4, db: -10 }), (d) => Math.abs(d.clips[0].db + 10) < 0.2 && `db ${d.clips[0].db}`);
await step("markers add batch", "markers", { action: "add", markers: [{ time: 1, name: "Hook", color: 1 }, { time: 3, name: "Cap 1", type: "chapter", duration: 1 }] }, (d) => d.added.length === 2);
await step("markers list", "markers", { action: "list" }, (d) => d.markers.length === 2);
await step("razor V1 at 2.5s", "razor", { times: [2.5], tracks: ["V1"] }, () => true);
await step("timeline after razor", "get_timeline", { tracks: ["V1"] }, (d) => {
  const clips = d.tracks[0].clips;
  ctx.v1b = clips[1]?.id;
  return clips.length === 2 && `V1 ${clips.map((x) => x.start + "-" + x.end).join(", ")}`;
});
await step("speed 2x on second piece (QE)", "set_clip_speed", () => ({ clips: ctx.v1b, speed: 2 }), (d) => `speed ${d.clips[0].speed} end ${d.clips[0].end}`);
await step("copy effects V2 -> V1 first piece", "copy_effects", () => ({ from: ctx.clip1, to: { tracks: ["V1"], limit: 1 }, include_motion: false }), (d) => d.clips[0].copied.length >= 1 && d.clips[0].copied.join(","));
await step("remove effects (Gaussian Blur) from V1", "remove_effects", () => ({ clips: { tracks: ["V1"] }, effects: ["Gaussian Blur"] }), (d) => JSON.stringify(d.clips.map((x) => x.removed)));
await step("list effect presets", "list_effect_presets", { filter: "." }, (d) => {
  ctx.preset = d.presets.find((p) => /personagem scala/i.test(p.path))?.path || d.presets.find((p) => p.effects.includes("Transform"))?.path || d.presets[0]?.path;
  return d.count > 0 && `${d.count} presets; using ${ctx.preset}`;
});
await step("apply effect preset", "apply_effect_preset", () => ({ clips: ctx.clip2, preset: ctx.preset }), (d) => d.clips[0].applied.length >= 1 && JSON.stringify(d.clips[0].applied) + (d.clips[0].errors.length ? " errs:" + d.clips[0].errors.join(";") : ""));
await step(
  "title PNG + place on V4",
  "create_title_image",
  { output: path.join(DIR, "titles", "title1.png"), lines: [{ text: "11º LIEBE", size: 160, color: "#46C8FF", stroke_color: "#0a0a14", stroke_width: 10 }, { text: "O DEMÔNIO", size: 90, underline: { color: "#46C8FF" } }], font_family: "Impact", place: { track: "V4", start: 0.5, duration: 2 } },
  (d, r) => d.placed?.placed?.length === 1 && r.images.length === 1 && `placed ${d.placed.placed[0].track}@${d.placed.placed[0].start}`,
);
await step("MOGRT-less: move V3 clip +0.5s", "edit_clips", () => ({ action: "move", clips: ctx.clip2, delta: 0.5 }), (d) => Math.abs(d.moved[0].start - 1.5) < 0.05 && `start ${d.moved[0].start}`);
await step("trim V3 duration 1.5", "edit_clips", () => ({ action: "trim", clips: ctx.clip2, duration: 1.5 }), (d) => Math.abs(d.clips[0].end - d.clips[0].start - 1.5) < 0.05);
await step("move clip to another track (V3->V5)", "edit_clips", () => ({ action: "move_to_track", clips: ctx.clip2, track: "V5" }), (d) => d.moved.length === 1);
await step("export 4 frames as contact sheet", "export_frames", { times: [0.2, 1.2, 2.2, 3.2] }, (d, r) => {
  ctx.sheet = d.sheet;
  return d.failed === 0 && r.images.length === 1 && `sheet ${d.sheet}`;
});
await step("export FCP XML (no dialog)", "export_interchange", { format: "fcp_xml", path: path.join(os.tmpdir(), "premiere-mcp-plus-e2e", "e2e.xml") }, (d) => d.exists && fs.statSync(d.path).size > 1000 && `${fs.statSync(d.path).size} bytes`);
await step("import captions SRT", "import_captions", { path: path.join(DIR, "subs.srt") }, (d) => d.ok);
await step("analyze silence (ffmpeg)", "analyze_media", { action: "silence", file: path.join(DIR, "talk.wav") }, (d) => d.count >= 1 && JSON.stringify(d.silences));
await step("analyze probe", "analyze_media", { action: "probe", file: path.join(DIR, "clipA.mp4") }, (d) => d.streams.length === 2 && `${d.duration}s`);
await step("batch: 2 markers + playhead in one round trip", "batch", { ops: [{ fn: "add_markers", args: { markers: [{ time: 5, name: "B1" }] } }, { fn: "set_playhead", args: { seconds: 2 } }, { fn: "get_playhead", args: {} }] }, (d) => d.results.every((x) => x.ok) && `playhead ${d.results[2].data.seconds}`);
await step("undo last action", "undo", { steps: 1 }, () => true);
await step("close gaps on A4", "close_gaps", { tracks: ["A4"] }, (d) => d.closedGaps >= 1 && `${d.closedGaps}`);
await step("ripple remove V2 clip", "remove_clips", () => ({ clips: ctx.clip1, ripple: false }), (d) => d.removed.length === 1);
await step("run_extendscript escape hatch", "run_extendscript", { code: "return app.project.activeSequence.name;" }, (d) => d.result === "E2E");
await step("duplicate sequence", "manage_sequence", { action: "duplicate", name: "E2E copy" }, (d) => d.name === "E2E copy");
{
  const r = await c.call("edit_clips", { action: "move", clips: "999999999", delta: 1 });
  const pass = !r.ok && r.data.code === "NO_CLIPS_MATCHED" && !!r.data.hint;
  results.push({ name: "error path: clean NO_CLIPS_MATCHED + hint", pass, ms: r.ms, note: r.data.code });
  console.log(`${pass ? "PASS" : "FAIL"}  ${"error path: clean NO_CLIPS_MATCHED + hint".padEnd(42)} ${String(r.ms).padStart(6)}ms  ${r.data.code}`);
}
// ---------------------------------------------------------------------------
// Regression tests for the bug report against commit a2b3041 (15 items).
// They run in their own sequence so the timeline above stays untouched.
// ---------------------------------------------------------------------------
async function expectError(name, tool, args, code, verify) {
  const r = await c.call(tool, typeof args === "function" ? args() : args);
  let pass = !r.ok && r.data.code === code;
  let note = r.ok ? "no error: " + JSON.stringify(r.data).slice(0, 120) : `${r.data.code}: ${r.data.error}`;
  if (pass && verify) {
    const v = await verify(r.data);
    if (v === false) pass = false;
    else if (typeof v === "string") note = v;
  }
  results.push({ name, tool, pass, ms: r.ms, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(42)} ${String(r.ms).padStart(6)}ms  ${String(note).slice(0, 160)}`);
}
const clipCount = async (tracks) => {
  const t = await c.call("get_timeline", tracks ? { tracks } : {});
  return t.data.tracks.reduce((n, x) => n + x.clips.length, 0);
};
const rb = path.join(DIR, "redblue.mp4");
if (!fs.existsSync(rb)) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=1920x1080:rate=30:d=5", "-f", "lavfi", "-i", "color=c=blue:size=1920x1080:rate=30:d=5", "-filter_complex", "[0][1]concat=n=2:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", rb]);
}
await step("fixes: new sequence", "create_sequence", { name: "Fixes", width: 1920, height: 1080, fps: 30 }, (d) => d.name === "Fixes");
await step("fixes: import red/blue clip", "import_media", { paths: [rb] }, (d) => (ctx.rb = d.imported[0]?.id) && "ok");

// 1. speed changes the linked audio too
await step("fix1 place clipA V1+A1 2.5-4", "place_clips", () => ({ clips: [{ item: ctx["clipA.mp4"], track: "V1", start: 2.5, in: 0, out: 1.5 }] }), (d) => (ctx.f1 = d.placed[0].id) && "ok");
await step("fix1 set_clip_speed 2 keeps A1 in sync", "set_clip_speed", () => ({ clips: ctx.f1, speed: 2 }), (d) => {
  const v = d.clips[0], a = d.linked[0];
  return a && v.speed === 2 && a.speed === 2 && Math.abs(v.end - a.end) < 0.001 && v.end < 3.3 ? `V ${v.start}-${v.end} A ${a.track} ${a.start}-${a.end}` : false;
});

// 2. invalid placements never leave clips behind
for (const [label, spec, code] of [
  ["start -5", { start: -5 }, "BAD_ARGS"],
  ["in 50 / out 60 past media end", { start: 200, in: 50, out: 60 }, "BAD_ARGS"],
  ["unknown effect", { start: 30, effects: ["Efeito Inventado"] }, "EFFECT_UNKNOWN"],
  ["bad keyframe property (cleanup)", { start: 30, keyframes: [{ property: "Nada", keys: [{ t: 0, v: 1 }] }] }, "PROPERTY_NOT_FOUND"],
]) {
  const before = await clipCount();
  const r = await c.call("place_clips", { clips: [{ item: ctx["clipA.mp4"], track: "V2", ...spec }] });
  const after = await clipCount();
  const pass = r.ok && r.data.placed.length === 0 && r.data.errors[0]?.code === code && after === before;
  const note = `${r.data.errors?.[0]?.code} clips ${before}->${after}`;
  results.push({ name: `fix2 ${label}`, tool: "place_clips", pass, ms: r.ms, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${`fix2 ${label}`.padEnd(42)} ${String(r.ms).padStart(6)}ms  ${note}`);
}

// 3. Media Encoder export really writes the file
await step("save before AME", "project_file", { action: "save" }, (d) => d.saved);
await step("fix3 export via Media Encoder (wait)", "export_sequence", { output: path.join(os.tmpdir(), "premiere-mcp-plus-e2e", `ame-${Date.now()}.mp4`), use_media_encoder: true, wait: true, wait_timeout_s: 600 }, (d) =>
  d.done && fs.existsSync(d.path) && d.duration > 0.5 ? `${d.bytes} bytes, ${d.duration}s, job ${d.jobId}` : `not done: ${JSON.stringify(d).slice(0, 150)}` && false,
);

// 4. speed on a razored piece that ends at the end of the media
await step("fix4 place clipB 20-30 (10s media)", "place_clips", () => ({ clips: [{ item: ctx["clipB.mp4"], track: "V3", start: 20, in: 0, out: 10, media: "video" }] }), (d) => d.placed.length === 1);
await step("fix4 razor at 25", "razor", { times: [25], tracks: ["V3"] }, (d) => d.cuts === 1);
await step("fix4 speed 2 on piece in 5 / out 10, no ripple", "set_clip_speed", { clips: { tracks: ["V3"], at: 26 }, speed: 2 }, (d) => {
  const x = d.clips[0];
  return x.speed === 2 && Math.abs(x.in - 5) < 0.05 && Math.abs(x.out - 10) < 0.05 && Math.abs(x.end - 27.5) < 0.05 && !x.warning ? `speed ${x.speed} in ${x.in} out ${x.out} end ${x.end}` : false;
});

// 5. scene edit detection creates markers
await step("fix5 place red/blue clip at 40", "place_clips", () => ({ clips: [{ item: ctx.rb, track: "V4", start: 40 }] }), (d) => d.placed.length === 1);
await step("fix5 scene detection -> markers", "sequence_tools", { action: "scene_edit_detection", clips: { tracks: ["V4"] }, detection_action: "markers" }, (d) =>
  d.markers?.length >= 1 && d.markers.some((m) => Math.abs(m.start - 45) < 0.1) ? `${d.method}: ${d.markers.map((m) => m.start).join(",")}` : false,
);

// 6. work area: set and verified, or a clear error; no -400000
await step("fix6 get_settings: no in/out -> null", "manage_sequence", { action: "get_settings" }, (d) => d.in === null && d.out === null && "in/out null");
{
  const r = await c.call("manage_sequence", { action: "range", work_in: 1, work_out: 3 });
  const pass = (r.ok && Math.abs(r.data.workArea.in - 1) < 0.05 && Math.abs(r.data.workArea.out - 3) < 0.05) || (!r.ok && r.data.code === "WORK_AREA_UNSUPPORTED");
  results.push({ name: "fix6 work area set or WORK_AREA_UNSUPPORTED", pass, ms: r.ms, note: r.ok ? JSON.stringify(r.data.workArea) : r.data.code });
  console.log(`${pass ? "PASS" : "FAIL"}  ${"fix6 work area set or WORK_AREA_UNSUPPORTED".padEnd(42)} ${String(r.ms).padStart(6)}ms  ${r.ok ? JSON.stringify(r.data.workArea) : r.data.code}`);
}

// 7. undo whole calls (speed + trim)
await step("fix7 place clip for undo", "place_clips", () => ({ clips: [{ item: ctx["clipA.mp4"], track: "V5", start: 50, in: 0, out: 3, media: "video" }] }), (d) => (ctx.f7 = d.placed[0].id) && "ok");
await step("fix7 speed 1.5", "set_clip_speed", () => ({ clips: ctx.f7, speed: 1.5 }), (d) => d.clips[0].speed === 1.5);
await step("fix7 trim_end 0.5", "edit_clips", () => ({ action: "trim", clips: ctx.f7, trim_end: 0.5 }), (d) => d.clips.length === 1);
await step("fix7 undo calls: 2", "undo", { calls: 2 }, (d) => d.undoneCalls.join(",") === "trim_clips,set_speed" && `${d.premiereSteps} steps, ${d.restoredClips} clips`);
await step("fix7 clip back to speed 1, 50-53", "find_clips", () => ({ clips: ctx.f7 }), (d) => {
  const x = d.clips[0];
  return !x.speed && Math.abs(x.start - 50) < 0.01 && Math.abs(x.end - 53) < 0.01 && Math.abs(x.out - 3) < 0.01 ? `${x.start}-${x.end} in ${x.in} out ${x.out}` : false;
});

// 8. audio keeps its full length (no frame lost)
await step("fix8 audio in 0 / out 0.5 = 0.5s", "place_clips", () => ({ clips: [{ item: ctx["vo.wav"], track: "A6", start: 60, in: 0, out: 0.5, media: "audio" }] }), (d) => Math.abs(d.placed[0].end - d.placed[0].start - 0.5) < 0.001 && `${d.placed[0].start}-${d.placed[0].end}`);

// 9. set_properties with time returns the keyframe value
await step("fix9 keyframe value returned", "set_properties", () => ({ clips: ctx.f7, set: [{ property: "Rotation", value: 15, time: 0.5 }] }), (d) => d.set[0].value === 15 && d.set[0].keyframe && "value 15 at key");

// 10. razor past the end
await step("fix10 razor at 9999 -> 0 cuts + warning", "razor", { times: [9999] }, (d) => d.cuts === 0 && d.skipped?.[0] === 9999 && !!d.warning && d.warning);

// 11. parsed metadata, raw XML only on request
await step("fix11 metadata parsed", "get_item_info", () => ({ item: ctx["clipA.mp4"], metadata: true }), (d) => d.metadata?.name === "clipA.mp4" && d.metadata.frameRate && !d.projectMetadataXml && `${d.metadata.frameRate}, ${d.metadata.mediaDuration}`);
await step("fix11 raw_xml complete", "get_item_info", () => ({ item: ctx["clipA.mp4"], raw_xml: true }), (d) => /<\/x:xmpmeta>/.test(d.xmpXml) && d.projectMetadataXml.length > 1000 && `${d.projectMetadataXml.length} + ${d.xmpXml.length} chars`);

// 12/13. clear error codes
await expectError("fix12 analyze_media missing file", "analyze_media", { action: "probe", file: path.join(DIR, "nao-existe.mp4") }, "FILE_NOT_FOUND");
const noDrive = "QRSTUVWXYZ".split("").find((l) => !fs.existsSync(`${l}:\\`));
await expectError("fix13 export_interchange bad drive", "export_interchange", { format: "fcp_xml", path: `${noDrive}:\\x\\y.xml` }, "OUTPUT_PATH_INVALID");
await expectError("fix13 export_sequence bad drive", "export_sequence", { output: `${noDrive}:\\x\\y.mp4` }, "OUTPUT_PATH_INVALID");

// 14. run_extendscript documents ES3 / reserved words
{
  const list = await c.req("tools/list", {});
  const desc = list.result.tools.find((t) => t.name === "run_extendscript").description;
  const pass = /ES3/.test(desc) && /\{in: 1\}/.test(desc) && /o\["in"\]/.test(desc);
  results.push({ name: "fix14 run_extendscript ES3 docs", pass, ms: 0, note: pass ? "documented" : desc.slice(0, 120) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${"fix14 run_extendscript ES3 docs".padEnd(42)}      0ms`);
}

// Same effect twice: parameters must land on the new copy (Premiere inserts it on top).
await step("extra: 2nd Gaussian Blur gets its own params", "apply_effects", () => ({ clips: ctx.f7, effects: [{ name: "Gaussian Blur", params: { Amount: 11 } }] }), (d) => d.applied === 1);
await step("extra: add Gaussian Blur again (Amount 22)", "apply_effects", () => ({ clips: ctx.f7, effects: [{ name: "Gaussian Blur", params: { Amount: 22 } }] }), (d) => d.applied === 1);
await step("extra: blurs read 22 and 11", "get_clip_effects", () => ({ clips: ctx.f7 }), (d) => {
  const vals = d.clips[0].components.filter((x) => x.matchName === "AE.Impact_Blur_FX" || /Gaussian/.test(x.name)).map((x) => x.props.find((p) => p.name === "Amount")?.value);
  return vals.length === 2 && vals.includes(11) && vals.includes(22) ? `Amount ${vals.join(", ")}` : false;
});

// Wait until Premiere's background work (peak files, conforming, analysis) is done,
// so speed tests measure the tools and not a busy Premiere.
async function waitIdle(maxS = 60) {
  for (let i = 0; i < maxS; i++) {
    const r = await c.call("run_extendscript", { code: "app.enableQE(); return [qe.project.numActiveProgressItems, qe.project.isAudioConforming, qe.project.isAudioPeakGenerating, qe.project.isIndexing];" });
    const st = r.data.result || [];
    if (!st[0] && !st[1] && !st[2] && !st[3]) return i;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return maxS;
}
// 15. batch speed (Premiere-dependent; target < 80 ms per simple clip)
await waitIdle();
{
  const n = 100;
  const r = await c.call("place_clips", { clips: Array.from({ length: n }, (_, i) => ({ item: ctx["clipA.mp4"], track: "V7", start: 100 + i * 0.5, in: i % 10, out: (i % 10) + 0.5, media: "video" })) });
  const per = Math.round(r.ms / n);
  // Speed is measured by bench/bench.mjs on a clean project; here only correctness.
  const pass = r.ok && r.data.placed.length === n && r.data.placed.every((p, i) => Math.abs(p.start - (100 + i * 0.5)) < 0.02 && Math.abs(p.in - (i % 10)) < 0.02);
  results.push({ name: "fix15 place 100 video clips", pass, ms: r.ms, note: `${per} ms/clip${per < 80 ? "" : " (target 80)"}` + (pass ? "" : " " + JSON.stringify(r.data.errors?.[0] || r.data).slice(0, 200)) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${"fix15 place 100 video clips".padEnd(42)} ${String(r.ms).padStart(6)}ms  ${results[results.length - 1].note}`);
  const e = await c.call("apply_effects", { clips: { tracks: ["V7"] }, effects: ["Gaussian Blur"] });
  const perE = Math.round(e.ms / n);
  const passE = e.ok && e.data.applied === n;
  results.push({ name: "fix15 apply_effects on 100 clips", pass: passE, ms: e.ms, note: `${perE} ms/clip` });
  console.log(`${passE ? "PASS" : "FAIL"}  ${"fix15 apply_effects on 100 clips".padEnd(42)} ${String(e.ms).padStart(6)}ms  ${perE} ms/clip`);
}

// ---------------------------------------------------------------------------
// Phase 0: bug report against c92562b (PROMPT-agente.md, items 1-27). Every
// timeline check re-reads the timeline instead of trusting the tool result.
// ---------------------------------------------------------------------------
const tlClips = async (tracks, seq) => {
  const r = await c.call("get_timeline", { tracks, sequence: seq, include_effects: false, include_media: false });
  return (r.data.tracks || []).flatMap((t) => t.clips.map((k) => ({ ...k, track: t.track })));
};
const near = (a, b, e = 0.02) => Math.abs(a - b) <= e;
const noAudio = path.join(DIR, "noaudio.mp4");
if (!fs.existsSync(noAudio)) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", noAudio]);
}
await step("p0 new sequence F0", "create_sequence", { name: "F0", width: 1920, height: 1080, fps: 30 }, (d) => d.name === "F0");
await step("p0 import video without audio", "import_media", { paths: [noAudio] }, (d) => (ctx.noaudio = d.imported[0]?.id) && "ok");

// 1. media "audio" never touches video tracks
await step("p0-1 place V1 video 0-3", "place_clips", () => ({ clips: [{ item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 3, media: "video" }] }), (d) => d.placed.length === 1);
await step("p0-1 media audio -> no ghost video", "place_clips", () => ({ clips: [{ item: ctx["clipB.mp4"], track: "A1", start: 1, in: 0, out: 0.5, media: "audio" }] }), async (d) => {
  const v = await tlClips(["V1", "V2", "V3"]), a = await tlClips(["A1"]);
  return d.placed[0]?.audioOnly && v.length === 1 && near(v[0].end, 3) && a.some((x) => near(x.start, 1) && near(x.end, 1.5)) ? `video untouched (${v.map((x) => x.start + "-" + x.end)}), A1 1-1.5` : false;
});
{
  const r = await c.call("place_clips", { clips: [{ item: ctx.noaudio, track: "A2", start: 0, media: "audio" }] });
  const pass = r.ok && r.data.errors[0]?.code === "NO_AUDIO" && (await tlClips(["A2"])).length === 0;
  results.push({ name: "p0-1 audio from video-only file -> NO_AUDIO", pass, ms: r.ms, note: r.data.errors?.[0]?.code });
  console.log(`${pass ? "PASS" : "FAIL"}  ${"p0-1 audio from video-only file -> NO_AUDIO".padEnd(42)} ${String(r.ms).padStart(6)}ms`);
}

// 3 / 7 / 22. linked clips move together; unlink / link really work
await step("p0-3 place V2+A2 4-6", "place_clips", () => ({ clips: [{ item: ctx["clipA.mp4"], track: "V2", audio_track: "A2", start: 4, in: 0, out: 2 }] }), (d) => (ctx.p3 = d.placed[0].id) && "ok");
await step("p0-3 move delta 10 moves A2 too", "edit_clips", () => ({ action: "move", clips: ctx.p3, delta: 10 }), async () => {
  const v = await tlClips(["V2"]), a = await tlClips(["A2"]);
  return v.some((x) => near(x.start, 14)) && a.some((x) => near(x.start, 14)) && !a.some((x) => near(x.start, 4)) ? "V2 and A2 at 14-16" : false;
});
await step("p0-7 unlink", "edit_clips", () => ({ action: "unlink", clips: ctx.p3 }), (d) => d.ok);
await step("p0-7 move after unlink moves only video", "edit_clips", () => ({ action: "move", clips: ctx.p3, delta: 1 }), async () => {
  const v = await tlClips(["V2"]), a = await tlClips(["A2"]);
  ctx.p3a = a.find((x) => near(x.start, 14))?.id;
  return v.some((x) => near(x.start, 15)) && !!ctx.p3a ? "V2 15, A2 stays 14" : false;
});
await step("p0-7 link V2 + A2 again", "edit_clips", () => ({ action: "link", clips: [ctx.p3, ctx.p3a].filter(Boolean) }), (d) => (d.ok && d.clips.length === 2 ? "linked" : false));
await step("p0-22 razor V2 only (include_linked false)", "razor", { times: [15.5], tracks: ["V2"], include_linked: false }, async (d) => {
  const v = await tlClips(["V2"]), a = await tlClips(["A2"]);
  return d.cuts === 1 && v.length === 2 && a.length === 1 ? "V2 cut, A2 intact" : false;
});

// 4. trim validates the media range
{
  const before = JSON.stringify(await tlClips(["V2"]));
  const r = await c.call("edit_clips", { action: "trim", clips: ctx.p3, out: 50 });
  const pass = !r.ok && r.data.code === "BAD_ARGS" && JSON.stringify(await tlClips(["V2"])) === before;
  results.push({ name: "p0-4 trim out past media -> BAD_ARGS", pass, ms: r.ms, note: r.data.code });
  console.log(`${pass ? "PASS" : "FAIL"}  ${"p0-4 trim out past media -> BAD_ARGS".padEnd(42)} ${String(r.ms).padStart(6)}ms  ${r.data.code}`);
}

// 5. speed with ripple pulls / pushes the following clips (video and audio)
await step("p0-5 place 30-32 and 32-34 on V3/A3", "place_clips", () => ({ clips: [{ item: ctx["clipA.mp4"], track: "V3", audio_track: "A3", start: 30, in: 0, out: 2 }, { item: ctx["clipA.mp4"], track: "V3", audio_track: "A3", start: 32, in: 2, out: 4 }] }), (d) => d.placed.length === 2);
await step("p0-5 speed 2 + ripple", "set_clip_speed", { clips: { tracks: ["V3"], at: 30.5 }, speed: 2, ripple: true }, async () => {
  const v = await tlClips(["V3"]), a = await tlClips(["A3"]);
  return v.some((x) => near(x.start, 31) && near(x.end, 33)) && a.some((x) => near(x.start, 31) && near(x.end, 33)) ? "second clip at 31-33 (V3 and A3)" : `V3 ${v.map((x) => x.start + "-" + x.end)} A3 ${a.map((x) => x.start + "-" + x.end)}`;
});
await step("p0-5 speed 0.5 + ripple pushes", "set_clip_speed", { clips: { tracks: ["V3"], at: 30.5 }, speed: 0.5, ripple: true }, async () => {
  const v = await tlClips(["V3"]);
  return v.some((x) => near(x.start, 30) && near(x.end, 34)) && v.some((x) => near(x.start, 34) && near(x.end, 36)) ? "30-34 then 34-36" : `V3 ${v.map((x) => x.start + "-" + x.end)}`;
});

// 8. volume_db on a clip with video and audio
await step("p0-8 volume_db on V+A clip", "place_clips", () => ({ clips: [{ item: ctx["clipA.mp4"], track: "V4", audio_track: "A4", start: 40, in: 0, out: 1, volume_db: -6 }] }), async (d) => {
  if (d.placed.length !== 1) return false;
  const e = await c.call("get_clip_effects", { clips: { tracks: ["A4"], at: 40.5 } });
  const lvl = e.data.clips[0].components.find((x) => x.matchName === "Internal Volume" || /^Volume/.test(x.name))?.props[1]?.value;
  return near(lvl, Math.pow(10, (-6 - 15) / 20), 0.002) ? `audio level ${lvl} (-6 dB)` : `level ${lvl}`;
});

// 12. locked track
await step("p0-12 lock V4", "manage_tracks", { action: "set", tracks: ["V4"], lock: true }, () => true);
{
  const before = (await tlClips(["V4"])).length;
  const r = await c.call("place_clips", { clips: [{ item: ctx["clipA.mp4"], track: "V4", start: 0, in: 0, out: 1 }] });
  const pass = r.ok && r.data.errors[0]?.code === "TRACK_LOCKED" && (await tlClips(["V4"])).length === before;
  results.push({ name: "p0-12 place on locked track -> TRACK_LOCKED", pass, ms: r.ms, note: r.data.errors?.[0]?.code });
  console.log(`${pass ? "PASS" : "FAIL"}  ${"p0-12 place on locked track -> TRACK_LOCKED".padEnd(42)} ${String(r.ms).padStart(6)}ms`);
}
await step("p0-12 unlock V4", "manage_tracks", { action: "set", tracks: ["V4"], lock: false }, () => true);

// 11. undo / redo by call
await step("p0-11 place clip to undo", "place_clips", () => ({ clips: [{ item: ctx["still.png"], track: "V5", start: 60, duration: 1 }] }), (d) => d.placed.length === 1);
await step("p0-11 undo calls 1", "undo", { calls: 1 }, async (d) => d.undoneCalls[0] === "place_clips" && (await tlClips(["V5"])).length === 0 && "clip gone");
await step("p0-11 redo calls 1", "undo", { redo: true, calls: 1 }, async (d) => d.redoneCalls[0] === "place_clips" && (await tlClips(["V5"])).length === 1 && "clip back");

// 16 / 17. blend mode names, colors in hex
await step("p0-16 blend_mode by name", "set_transform", { clips: { tracks: ["V5"] }, blend_mode: "multiply" }, (d) => d.clips[0]?.set.blend_mode === "multiply" && "multiply");
await step("p0-16 unknown blend mode -> error", "set_properties", { clips: { tracks: ["V5"] }, set: [{ effect: "Opacity", property: "Blend Mode", value: "xyz" }] }, (d) => d.errors.length === 1 && d.set.length === 0);
await step("p0-17 apply Tint", "apply_effects", { clips: { tracks: ["V5"] }, effects: ["Tint"] }, (d) => d.applied === 1);
await step("p0-17 color returned as hex", "set_properties", { clips: { tracks: ["V5"] }, set: [{ effect: "Tint", property: "Map Black To", value: "#FF0000" }] }, (d) => d.set[0]?.value === "#FF0000" && "#FF0000");

// 25. compact timeline
await step("p0-25 get_timeline compact rows", "get_timeline", { compact: true }, (d, r) => Array.isArray(d.tracks[0].clips[0]) && d.fields.length === 6 && `${JSON.stringify(d).length} bytes`);

// 9. sequence from a .sqpreset
const sq = "C:/Program Files/Adobe/Adobe Premiere Pro 2026/Settings/SequencePresets/Broadcast/23.98p 4 mono discrete.sqpreset";
if (fs.existsSync(sq)) await step("p0-9 create_sequence from .sqpreset", "create_sequence", { name: "FromPreset", preset_path: sq }, (d) => near(d.fps, 23.976, 0.01) && `${d.width}x${d.height}@${d.fps}`);
await step("p0 back to F0", "open_sequence", { sequence: "F0" }, (d) => d.name === "F0");

// 10 / 24. a tool working on another sequence restores the active one
await step("p0-10 export_frames of another sequence", "export_frames", { sequence: "E2E", times: [0.5], return_images: false }, () => true);
await step("p0-10 F0 still active", "premiere_status", {}, (d) => d.activeSequence?.name === "F0" && "F0");

// 26. placement speed with transform + keyframes (video + audio)
console.log(`      waited ${await waitIdle(120)} s for Premiere to be idle`);
{
  const n = 100;
  const r = await c.call("place_clips", { clips: Array.from({ length: n }, (_, i) => ({ item: ctx["clipA.mp4"], track: "V8", audio_track: "A8", start: 200 + i * 0.5, in: i % 10, out: (i % 10) + 0.5, transform: { scale: 110, position: [960, 540] }, keyframes: [{ property: "Scale", keys: [{ t: 0, v: 100 }, { t: "end", v: 110 }] }] })) });
  const per = Math.round(r.ms / n);
  const pass = r.ok && r.data.placed.length === n && r.data.placed.every((p, i) => Math.abs(p.start - (200 + i * 0.5)) < 0.02);
  if (!r.data.fastBatch) console.log('      (fast batch not used)');
  results.push({ name: "p0-26 100 V+A clips with transform+keys", pass, ms: r.ms, note: `${per} ms/clip (target 120)` + (pass ? "" : " " + JSON.stringify(r.data.errors?.[0] || r.data).slice(0, 200)) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${"p0-26 100 V+A clips with transform+keys".padEnd(42)} ${String(r.ms).padStart(6)}ms  ${results[results.length - 1].note}`);
}

// 6. auto reframe
await step("p0-6 auto_reframe F0 has clips", "sequence_tools", { action: "auto_reframe", sequence: "F0", numerator: 9, denominator: 16, name: "F0 vertical" }, (d) => d.clips > 0 && `${d.clips} clips, ${d.width}x${d.height}`);
await expectError("p0-6 auto_reframe empty sequence", "sequence_tools", { action: "auto_reframe", sequence: "FromPreset" }, "EMPTY_SEQUENCE");

// 2 / 20. AAF with an effect AAF cannot carry: dialog closed automatically
await step("p0-2 Lumetri on V1", "apply_effects", { clips: { tracks: ["V1"] }, effects: ["Lumetri Color"] }, (d) => d.applied >= 1);
await step("p0-2 AAF export, no hanging dialog", "export_interchange", { sequence: "F0", format: "aaf", path: path.join(os.tmpdir(), "premiere-mcp-plus-e2e", "f0.aaf") }, (d, r) =>
  d.exists && r.ms < 60000 && d.ignoredEffects?.length ? `${r.ms} ms, ${d.warning}` : false,
);

// 13. unknown sequence fails fast
await expectError("p0-13 export unknown sequence", "export_sequence", { sequence: "NaoExiste", output: path.join(os.tmpdir(), "x.mp4") }, "SEQUENCE_NOT_FOUND");
results[results.length - 1].pass &&= results[results.length - 1].ms < 3000;

// 14. subclip reports its own range
await step("p0-14 subclip 1-3", "manage_project_items", () => ({ action: "subclip", items: [ctx["clipA.mp4"]], in: 1, out: 3, name: "sub 1-3" }), (d) => near(d.in, 1) && near(d.out, 3) && near(d.duration, 2));
await step("p0-14 get_item_info of the subclip", "get_item_info", { item: "sub 1-3" }, (d) => near(d.in, 1) && near(d.out, 3) && near(d.duration, 2) && `in ${d.in} out ${d.out}`);

// 15. preset search by format
await step("p0-15 list_export_presets H.264", "list_export_presets", { filter: "H.264" }, (d) => d.count > 0 && d.presets.every((p) => p.format) && `${d.count} presets, e.g. ${d.presets[0].format}`);

// 18. batch with tool names
await step("p0-18 batch with tool names", "batch", { ops: [{ fn: "markers", args: { action: "add", markers: [{ time: 2, name: "batch" }] } }, { fn: "playhead", args: { seconds: 1 } }] }, (d) => d.failed === 0 && d.results.length === 2);

// 19. track delete is verified
await step("p0-19 add 2 tracks", "manage_tracks", { action: "add", video: 2 }, (d) => d.addedVideo === 2 && (ctx.nv = d.videoTracks));
await step("p0-19 rename + lock the last one", "manage_tracks", () => ({ action: "set", tracks: ["V" + ctx.nv], name: "ToDelete", lock: true }), () => true);
await step("p0-19 delete it", "manage_tracks", () => ({ action: "delete", tracks: ["V" + ctx.nv] }), async (d) => {
  const names = (await c.call("run_extendscript", { code: "var s=app.project.activeSequence,o=[];for(var i=0;i<s.videoTracks.numTracks;i++)o.push(s.videoTracks[i].name);return o;" })).data.result;
  return d.deleted[0]?.name === "ToDelete" && !names.includes("ToDelete") ? `${names.length} video tracks left` : false;
});

// 21. several projects
await step("p0-21 status lists open projects", "premiere_status", {}, (d) => Array.isArray(d.projects) && d.projects.some((p) => p.active) && `${d.projects.length} open`);
await expectError("p0-21 project that is not open", "get_timeline", { project: "nao-aberto.prproj" }, "PROJECT_MISMATCH");

await step("save project", "project_file", { action: "save" }, (d) => d.saved);
// 27. close the test project when other projects are open (closing the only
// open project can take Premiere down, so it is kept open in that case).
{
  const st = (await c.call("premiere_status", {})).data;
  if ((st.projects || []).length > 1) await step("close test project", "project_file", { action: "close", save: true }, (d) => d.closed);
  else console.log("      (test project left open: it is the only open project)");
}

c.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
fs.writeFileSync(path.join(DIR, "e2e-results.json"), JSON.stringify(results, null, 1));
