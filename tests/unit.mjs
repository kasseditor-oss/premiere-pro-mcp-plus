// Offline unit tests of the pure helpers (no Premiere). Run after `npm run build`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (m) => import(pathToFileURL(path.join(root, "dist", m)).href);
const an = await load("analysis.js");
const ae = await load("autoedit.js");
const { JobManager } = await load("jobs.js");
const titles = await load("titles.js");

let n = 0;
const test = async (name, fn) => {
  await fn();
  n++;
  console.log("ok  " + name);
};

await test("autoThreshold: clear silence is reliable", () => {
  const db = [...Array(200).fill(-70), ...Array(200).fill(-20)];
  const t = an.autoThreshold({ db });
  assert.equal(t.reliable, true);
  assert.ok(t.threshold > -70 && t.threshold < -20, String(t.threshold));
});

await test("autoThreshold: constant noise is not reliable and cuts nothing", () => {
  // Loud podcast in a car: floor -14 dB, peaks -3 dB.
  const db = Array.from({ length: 400 }, (_, i) => -14 + (i % 10));
  const t = an.autoThreshold({ db });
  assert.equal(t.reliable, false);
  assert.equal(an.activeRegions({ hop: 0.02, db }, t.threshold, 0.3, 0.06).length, 1, "whole clip is active");
});

await test("fillers pt: 'e' and 'um' are not fillers, 'é' needs a pause", () => {
  const words = [
    { start: 0, end: 0.2, word: "eu" },
    { start: 0.25, end: 0.3, word: "e" },
    { start: 0.35, end: 0.5, word: "um" },
    { start: 0.55, end: 0.8, word: "amigo" },
    { start: 0.85, end: 1.0, word: "é" },
    { start: 1.05, end: 1.3, word: "legal" },
    { start: 2.0, end: 2.3, word: "é..." },
    { start: 2.8, end: 3.0, word: "né?" },
    { start: 3.5, end: 3.8, word: "ãh" },
  ];
  const list = ae.fillersFor("pt");
  assert.ok(!list.includes("um") && !list.includes("e"));
  const got = ae.fillerRanges(words, list).map((f) => f.word);
  assert.deepEqual(got, ["é", "né", "ãh"]);
});

await test("fillers en keep um/uh", () => {
  const words = [
    { start: 0, end: 0.2, word: "Um," },
    { start: 0.3, end: 0.6, word: "today" },
    { start: 0.7, end: 0.8, word: "uh" },
  ];
  assert.deepEqual(ae.fillerRanges(words, ae.fillersFor("en")).map((f) => f.word), ["um", "uh"]);
});

await test("fillersFor(unknown) has no Portuguese function words", () => {
  const l = ae.fillersFor(undefined);
  assert.ok(!l.includes("um") && !l.includes("e") && l.includes("uh") && l.includes("né"));
});

await test("jobs persist to disk and survive a new manager", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpjobs-"));
  const a = new JobManager(dir);
  const id = a.start("demo", async () => ({ value: 42 }));
  await a.wait(id, 2000);
  const b = new JobManager(dir);
  const s = b.status(id);
  assert.equal(s.state, "done");
  assert.equal(s.result.value, 42);
  assert.ok(b.list().some((j) => j.job_id === id));
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("jobs of a dead process show as lost", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpjobs-"));
  fs.writeFileSync(path.join(dir, "job_deadbeef.json"), JSON.stringify({ job_id: "job_deadbeef", tool: "x", state: "running", pid: 999999, startedAt: 1 }));
  assert.equal(new JobManager(dir).status("job_deadbeef").state, "lost");
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("title with a missing font warns and falls back", () => {
  const out = path.join(os.tmpdir(), `mcp-title-${Date.now()}.png`);
  const r = titles.renderTitle({ lines: [{ text: "Oi" }], font_family: "Fonte Que Nao Existe", output: out });
  assert.ok(r.warning && r.family === "Arial");
  const ok = titles.renderTitle({ lines: [{ text: "Oi" }], font_family: "Arial", output: out });
  assert.equal(ok.warning, undefined);
  fs.rmSync(out, { force: true });
});

console.log(`\nunit: ${n} passed`);
