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
      const v = check(r.data, r);
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
  return r;
}

const proj = path.join(DIR, `e2e-${Date.now()}.prproj`);
await step("status", "premiere_status", {}, (d) => d.connected === true && `Premiere ${d.premiere}, locale ${d.locale}`);
await step("new project", "project_file", { action: "new", path: proj }, (d) => d.created);
await step("import folder into bin", "import_media", { folder: DIR, bin: "Test" }, (d) => {
  for (const it of d.imported) ctx[it.name] = it.id;
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
await step("export FCP XML (no dialog)", "export_interchange", { format: "fcp_xml", path: path.join(DIR, "e2e.xml") }, (d) => d.exists && fs.statSync(d.path).size > 1000 && `${fs.statSync(d.path).size} bytes`);
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

// 15. batch speed (Premiere-dependent; target < 80 ms per simple clip)
{
  const n = 100;
  const r = await c.call("place_clips", { clips: Array.from({ length: n }, (_, i) => ({ item: ctx["clipA.mp4"], track: "V7", start: 100 + i * 0.5, in: i % 10, out: (i % 10) + 0.5, media: "video" })) });
  const per = Math.round(r.ms / n);
  const pass = r.ok && r.data.placed.length === n && per < 150;
  results.push({ name: "fix15 place 100 video clips", pass, ms: r.ms, note: `${per} ms/clip${per < 80 ? "" : " (target 80)"}` });
  console.log(`${pass ? "PASS" : "FAIL"}  ${"fix15 place 100 video clips".padEnd(42)} ${String(r.ms).padStart(6)}ms  ${per} ms/clip`);
  const e = await c.call("apply_effects", { clips: { tracks: ["V7"] }, effects: ["Gaussian Blur"] });
  const perE = Math.round(e.ms / n);
  const passE = e.ok && e.data.applied === n && perE < 150;
  results.push({ name: "fix15 apply_effects on 100 clips", pass: passE, ms: e.ms, note: `${perE} ms/clip` });
  console.log(`${passE ? "PASS" : "FAIL"}  ${"fix15 apply_effects on 100 clips".padEnd(42)} ${String(e.ms).padStart(6)}ms  ${perE} ms/clip`);
}

await step("save project", "project_file", { action: "save" }, (d) => d.saved);

c.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
fs.writeFileSync(path.join(DIR, "e2e-results.json"), JSON.stringify(results, null, 1));
