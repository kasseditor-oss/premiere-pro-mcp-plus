// Speed benchmark on a clean project. Usage: node bench/bench.mjs [mediaDir]
// Needs Premiere with the panel running and, in mediaDir, clipA.mp4 (video+audio,
// >= 10 s) and vo.wav (see tests/README.md). Results go to bench/results/<lib>.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../tests/mcp-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(process.argv[2] || "D:/mcp-plus-e2e");
const N = 125; // 4 placements of N clips -> 500 timeline clips
const c = await connect();
const call = async (tool, args) => {
  const r = await c.call(tool, args);
  if (!r.ok) throw new Error(`${tool}: ${JSON.stringify(r.data)}`);
  // A batch that "succeeds" with per-clip errors would make the numbers meaningless.
  if (r.data?.errors?.length) throw new Error(`${tool}: ${r.data.errors.length} errors, first: ${JSON.stringify(r.data.errors[0])}`);
  return r;
};

const status = (await call("premiere_status", {})).data;
if ((status.projects || []).length > 1) console.log(`warning: ${status.projects.length} projects open; close the others for comparable numbers`);
const proj = path.join(os.tmpdir(), "premiere-mcp-plus-bench", `bench-${Date.now()}.prproj`);
fs.mkdirSync(path.dirname(proj), { recursive: true });
await call("project_file", { action: "new", path: proj });
const imp = (await call("import_media", { paths: [path.join(DIR, "clipA.mp4"), path.join(DIR, "vo.wav")] })).data.imported;
const id = Object.fromEntries(imp.map((i) => [i.name, i.id]));
await call("create_sequence", { name: "Bench", width: 1920, height: 1080, fps: 30 });

async function idle() {
  for (let i = 0; i < 120; i++) {
    const st = (await call("run_extendscript", { code: "app.enableQE(); return [qe.project.numActiveProgressItems, qe.project.isAudioConforming, qe.project.isAudioPeakGenerating, qe.project.isIndexing];" })).data.result;
    if (!st.some(Boolean)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const results = {};
async function measure(name, n, fn, skipIdle = false) {
  if (!skipIdle) await idle();
  const t = Date.now();
  await fn();
  const ms = Date.now() - t;
  results[name] = { totalMs: ms, perItemMs: Math.round(ms / n), n };
  console.log(`${name.padEnd(40)} ${String(Math.round(ms / n)).padStart(5)} ms/item  (${ms} ms, n=${n})`);
}

const range = (k) => Array.from({ length: N }, (_, i) => k(i));
await measure("place_clips video", N, () => call("place_clips", { clips: range((i) => ({ item: id["clipA.mp4"], track: "V1", start: i * 0.5, in: i % 10, out: (i % 10) + 0.5, media: "video" })) }));
await measure("place_clips audio", N, () => call("place_clips", { clips: range((i) => ({ item: id["vo.wav"], track: "A3", start: i * 0.5, in: (i % 10) * 0.5, out: (i % 10) * 0.5 + 0.5, media: "audio" })) }));
await measure("place_clips V+A transform+keyframes", N, () =>
  call("place_clips", { clips: range((i) => ({ item: id["clipA.mp4"], track: "V2", audio_track: "A2", start: i * 0.5, in: i % 10, out: (i % 10) + 0.5, transform: { scale: 110, position: [960, 540] }, keyframes: [{ property: "Scale", keys: [{ t: 0, v: 100 }, { t: "end", v: 110 }] }] })) }),
);
await measure("apply_effects", N, () => call("apply_effects", { clips: { tracks: ["V1"] }, effects: ["Gaussian Blur"] }));
const total = (await call("get_timeline", { compact: true, fields: ["id"] })).data.tracks.reduce((n, t) => n + t.clips.length, 0);
await measure(`get_timeline compact (${total} clips)`, 1, () => call("get_timeline", { compact: true, tracks: ["V1", "V2", "A2", "A3", "V9"] }));
await measure(`get_timeline compact cached (${total} clips)`, 1, () => call("get_timeline", { compact: true }), true);
await measure(`get_timeline compact id/start/end (${total} clips)`, 1, () => call("get_timeline", { compact: true, fields: ["id", "start", "end"], tracks: ["V1", "V2", "A2", "A3", "V8"] }));
await measure("premiere_status (x20)", 20, async () => {
  for (let i = 0; i < 20; i++) await call("premiere_status", {});
});
const list = await c.req("tools/list", {});
results.toolsListBytes = JSON.stringify(list.result).length;
console.log(`tools/list ${results.toolsListBytes} bytes`);

const outDir = path.join(here, "results");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${status.lib || "unknown"}.json`);
fs.writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), premiere: status.premiere, lib: status.lib, results }, null, 1));
console.log("saved", file);
const st2 = (await call("premiere_status", {})).data;
if ((st2.projects || []).length > 1) await call("project_file", { action: "close", save: false });
c.close();
