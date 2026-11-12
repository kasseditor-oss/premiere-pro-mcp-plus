// Regression test for the bug report of 2026-11-11 (10 items). Needs a running
// Premiere with the panel. Usage: node tests/e2e-bugfixes.mjs [mediaDir]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./mcp-client.mjs";

const DIR = path.resolve(process.argv[2] || "D:/mcp-plus-test");
const c = await connect();
const results = [];
const near = (a, b, tol = 0.04) => Math.abs(a - b) <= tol;
function report(name, pass, note = "") {
  results.push({ name, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${String(note).slice(0, 170)}`);
}
async function must(tool, args) {
  const r = await c.call(tool, args);
  if (!r.ok) throw new Error(`${tool}: ${JSON.stringify(r.data)}`);
  return r.data;
}
async function check(name, fn) {
  try {
    const out = await fn();
    report(name, out.pass, out.note);
  } catch (e) {
    report(name, false, e.message);
  }
}
const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

const stamp = Date.now();
await must("project_file", { action: "new", path: path.join(DIR, `bugfix-${stamp}.prproj`) });
const imp = await must("import_media", { paths: [path.join(DIR, "clipA.mp4"), path.join(DIR, "clipB.mp4"), path.join(DIR, "still.png")], bin: "Midia/Teste" });
const id = Object.fromEntries(imp.imported.map((i) => [i.name, i.id]));
const seq = await must("create_sequence", { name: "Bugfix", width: 1920, height: 1080, fps: 30 });

// 5. import lands in the deepest bin and reports it
await check("5  import_media bin 'Midia/Teste' (report + real location)", async () => {
  const l = await must("list_project_items", { name_regex: "clipA|clipB|still" });
  const bins = l.items.map((i) => i.bin);
  const reported = imp.imported.map((i) => i.bin);
  return { pass: bins.every((b) => b === "Midia/Teste") && reported.every((b) => b === "Midia/Teste"), note: `listed ${bins.join(",")} reported ${reported.join(",")}` };
});

// 1. speed after razor
await check("1  set_clip_speed 2x on razored piece (in 5)", async () => {
  await must("place_clips", { clips: [{ item: id["clipA.mp4"], track: "V1", start: 8, in: 0, out: 10 }] });
  await must("razor", { times: [13], tracks: ["V1"] });
  const tl = await must("get_timeline", { tracks: ["V1"] });
  const piece = tl.tracks[0].clips[1];
  const r = await must("set_clip_speed", { clips: piece.id, speed: 2 });
  const after = (await must("get_timeline", { tracks: ["V1"] })).tracks[0].clips[1];
  const ok = near(after.speed, 2, 0.001) && near(after.in, 5) && near(after.out, 10) && near(after.end, 15.5);
  return { pass: ok, note: `speed ${after.speed} in ${after.in} out ${after.out} end ${after.end}${r.clips[0].warning ? " warn " + r.clips[0].warning : ""}` };
});
await check("1b speed 2x on first piece (in 0) and ripple off", async () => {
  const tl = await must("get_timeline", { tracks: ["V1"] });
  const first = tl.tracks[0].clips[0];
  await must("set_clip_speed", { clips: first.id, speed: 2 });
  const a = (await must("get_timeline", { tracks: ["V1"] })).tracks[0].clips[0];
  return { pass: near(a.speed, 2, 0.001) && near(a.in, 0) && near(a.out, 5) && near(a.start, 8) && near(a.end, 10.5), note: JSON.stringify(a) };
});

// 3. trim keeps outPoint in sync (and the in point when trimming the start)
await check("3  edit_clips trim_end 1 updates outPoint", async () => {
  const p = await must("place_clips", { clips: [{ item: id["clipB.mp4"], track: "V2", start: 1, in: 0, out: 5, media: "video" }] });
  const cid = p.placed[0].id;
  const r = await must("edit_clips", { action: "trim", clips: cid, trim_end: 1 });
  const raw = await must("run_extendscript", { code: `var s=app.project.activeSequence,t=s.videoTracks[1];for(var i=0;i<t.clips.numItems;i++)if(t.clips[i].nodeId=="${cid}")return [t.clips[i].start.seconds,t.clips[i].end.seconds,t.clips[i].inPoint.seconds,t.clips[i].outPoint.seconds];` });
  const [st, en, cin, cout] = raw.result;
  const ret = r.clips[0];
  return { pass: near(st, 1) && near(en, 5) && near(cin, 0) && near(cout, 4) && near(ret.out, 4) && near(ret.duration, 4), note: `premiere start ${st} end ${en} in ${cin} out ${cout}; returned out ${ret.out}` };
});
await check("3b edit_clips trim_start 0.5 moves inPoint too", async () => {
  const cid = (await must("get_timeline", { tracks: ["V2"] })).tracks[0].clips[0].id;
  const r = await must("edit_clips", { action: "trim", clips: cid, trim_start: 0.5 });
  const x = r.clips[0];
  return { pass: near(x.start, 1.5) && near(x.end, 5) && near(x.in, 0.5) && near(x.out, 4), note: JSON.stringify(x) };
});

// 2. export range in_out
await check("2  export_sequence range in_out = 4s file", async () => {
  await must("project_file", { action: "save" });
  await must("manage_sequence", { action: "range", in: 0, out: 4 });
  const out = path.join(DIR, `exports-${stamp}`, "inout.mp4"); // folder does not exist yet (item 4)
  const r = await must("export_sequence", { output: out, range: "in_out" });
  const d = probe(out);
  const active = await must("get_project", {});
  // content check: 0.5s is the leading gap (black), 2.5s shows the V2 clip
  const lum = (t) => {
    const buf = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "scale=32:18,format=gray", "-f", "rawvideo", "-"]);
    return buf.reduce((x, y) => x + y, 0) / buf.length;
  };
  const gap = lum(0.5), content = lum(2.5);
  return { pass: near(d, 4, 0.1) && gap < 8 && content > 30 && active.active.name === "Bugfix", note: `file ${d}s, luma@0.5=${gap.toFixed(1)} luma@2.5=${content.toFixed(1)}, range ${JSON.stringify(r.range)}, active ${active.active.name}` };
});

// 4. missing folders
await check("4  export_interchange fcp_xml into missing folder", async () => {
  const p = path.join(DIR, `missing-${stamp}`, "a", "b", "seq.xml");
  const r = await must("export_interchange", { format: "fcp_xml", path: p });
  return { pass: r.exists && fs.existsSync(p), note: `${p} ${fs.existsSync(p) ? fs.statSync(p).size + " bytes" : "missing"}` };
});
await check("4b export_frames into missing folder", async () => {
  const folder = path.join(DIR, `frames-${stamp}`, "x");
  const r = await c.call("export_frames", { times: [1], folder, contact_sheet: false, return_images: false });
  return { pass: r.ok && fs.readdirSync(folder).some((f) => f.endsWith(".png")), note: JSON.stringify(r.data).slice(0, 150) };
});

// 6. preset reports the real effects
await check("6  apply_effect_preset reports real effect names", async () => {
  const p = await must("place_clips", { clips: [{ item: id["still.png"], track: "V3", start: 0, duration: 3 }] });
  const r = await must("apply_effect_preset", { clips: p.placed[0].id, preset: "CANAL ANIME/personagem scala" });
  const names = r.clips[0].applied.map((x) => x.effect);
  const fx = await must("get_clip_effects", { clips: p.placed[0].id, include_values: false });
  const comps = fx.clips[0].components.map((x) => x.name);
  const ok = names.length === 3 && new Set(names).size === 3 && names.every((n) => comps.includes(n));
  return { pass: ok, note: `reported ${names.join(" | ")}; on clip ${comps.join(" | ")}` };
});

// 7. titles and captions go into their bins
await check("7  create_title_image place -> bin _MCP Plus/Titles", async () => {
  const r = await must("create_title_image", { output: path.join(DIR, "titles", `t-${stamp}.png`), lines: [{ text: "TESTE" }], place: { track: "V4", start: 0, duration: 1 }, preview: false });
  const it = (await must("list_project_items", { name_regex: `t-${stamp}` })).items[0];
  return { pass: it && it.bin === "_MCP Plus/Titles", note: `bin ${it && it.bin}` };
});
await check("7b import_captions -> bin _MCP Plus/Captions", async () => {
  const r = await must("import_captions", { path: path.join(DIR, "subs.srt") });
  const it = (await must("list_project_items", { name_regex: "subs\\.srt" })).items[0];
  return { pass: r.ok && it && it.bin === "_MCP Plus/Captions", note: `bin ${it && it.bin}` };
});

// 8. duplicate / auto reframe keep the active sequence
await check("8  duplicate keeps original active", async () => {
  const r = await must("manage_sequence", { action: "duplicate", name: "Bugfix copy" });
  const s = await must("get_project", {});
  return { pass: s.active.name === "Bugfix" && r.activeSequence.name === "Bugfix", note: `active ${s.active.name}` };
});
await check("8b auto_reframe keeps original active", async () => {
  const r = await c.call("sequence_tools", { action: "auto_reframe", numerator: 9, denominator: 16, name: "Bugfix 9x16" });
  const s = await must("get_project", {});
  return { pass: r.ok && s.active.name === "Bugfix", note: r.ok ? `new ${r.data.name} ${r.data.width}x${r.data.height}, active ${s.active.name}` : JSON.stringify(r.data) };
});

// 9. native MOGRT import
await check("9  native .mogrt import is a success with warning", async () => {
  const r = await c.call("mogrt", { action: "import", path: "C:/Program Files/Adobe/Adobe Premiere Pro 2026/Essential Graphics/Basic Lower Third.mogrt", track: "V5", start: 0 });
  return { pass: r.ok && r.data.imported && !!r.data.id && !!r.data.warning, note: JSON.stringify(r.data).slice(0, 160) };
});

// 10. minors
await check("10a list_project_items sequence fps", async () => {
  const l = await must("list_project_items", { types: ["sequence"], details: true });
  const s = l.items.find((i) => i.name === "Bugfix");
  return { pass: s && s.fps === 30, note: `fps ${s && s.fps}` };
});
await check("10b EDL export (fallback generator)", async () => {
  const p = path.join(DIR, `edl-${stamp}`, "seq.edl");
  const r = await must("export_interchange", { format: "edl", path: p });
  const txt = fs.readFileSync(p, "utf-8");
  return { pass: /^TITLE: Bugfix/m.test(txt) && /^001 /m.test(txt) && r.events >= 2, note: `${r.generator}, ${r.events} events` };
});
await check("10c Gaussian Blur reports match name; Blurriness alias", async () => {
  const p = await must("place_clips", { clips: [{ item: id["clipA.mp4"], track: "V6", start: 20, duration: 2, media: "video" }] });
  const a = await must("apply_effects", { clips: p.placed[0].id, effects: [{ name: "Gaussian Blur", params: { Blurriness: 40 } }] });
  const l = await must("apply_effects", { clips: p.placed[0].id, effects: ["Gaussian Blur (Legacy)"] });
  return { pass: a.results[0].added && a.results[0].set?.includes("Blurriness") && l.results[0].added, note: `${a.results[0].effect} [${a.results[0].matchName}] + ${l.results[0].effect} [${l.results[0].matchName}]` };
});
await check("10d scene_edit_detection returns markers list", async () => {
  const p = await must("place_clips", { clips: [{ item: id["clipB.mp4"], track: "V7", start: 30, media: "video" }] });
  const r = await must("sequence_tools", { action: "scene_edit_detection", clips: p.placed[0].id, detection_action: "markers" });
  return { pass: r.ok && Array.isArray(r.markers), note: `${r.markers.length} markers` };
});

// Close the test project (saved) when another project is open; closing the
// only open project can take Premiere down, so it stays open then.
{
  const st = (await c.call("premiere_status", {})).data;
  if ((st.projects || []).length > 1) await c.call("project_file", { action: "close", save: true });
}
c.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
