// End-to-end test against a live Premiere Pro with the CEP panel running.
// Usage: node tests/e2e-premiere.mjs [mediaDir]
import fs from "node:fs";
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
await step("save project", "project_file", { action: "save" }, (d) => d.saved);

c.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
fs.writeFileSync(path.join(DIR, "e2e-results.json"), JSON.stringify(results, null, 1));
