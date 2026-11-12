// Shared helpers for the live end-to-end suites (phase tests).
import fs from "node:fs";
import path from "node:path";
import { connect } from "./mcp-client.mjs";

export const near = (a, b, tol = 0.05) => typeof a === "number" && Math.abs(a - b) <= tol;

/**
 * Start a suite: connects, creates a fresh test project in dir, imports the
 * media and returns helpers. Every write step should re-read Premiere in its
 * check (get_timeline, find_clips...), never trust the write result alone.
 */
export async function suite(name, dir, env = {}) {
  const raw = await connect(env);
  const results = [];
  const ctx = {};
  // Safety: once the test project exists, every call carries expected_project_path,
  // so a test can never edit another open project (the server answers PROJECT_MISMATCH).
  const SKIP = new Set(["project_file", "premiere_status", "bridge_stats", "jobs", "analyze_media", "list_export_presets", "list_effect_presets", "undo", "batch"]);
  const c = {
    ...raw,
    call: (tool, args = {}) => raw.call(tool, ctx.projectPath && !SKIP.has(tool) && !args.expected_project_path && !args.project ? { ...args, expected_project_path: ctx.projectPath } : args),
  };
  async function step(title, tool, args, check) {
    const r = await c.call(tool, typeof args === "function" ? args() : args);
    let pass = r.ok;
    let note = "";
    if (pass && check) {
      try {
        const v = await check(r.data, r);
        if (v === false || v === undefined || v === null || v === 0) { pass = false; note = "got " + JSON.stringify(r.data).slice(0, 300); }
        else if (typeof v === "string") note = v;
      } catch (e) {
        pass = false;
        note = "check threw: " + e.message;
      }
    }
    if (!r.ok) note = typeof r.data === "object" ? `${r.data.code}: ${r.data.error}` : String(r.data);
    results.push({ name: title, tool, pass, ms: r.ms, note });
    console.log(`${pass ? "PASS" : "FAIL"}  ${title.padEnd(48)} ${String(r.ms).padStart(6)}ms  ${note.slice(0, 170)}`);
    return r;
  }
  async function expectError(title, tool, args, code) {
    const r = await c.call(tool, typeof args === "function" ? args() : args);
    const pass = !r.ok && r.data?.code === code;
    results.push({ name: title, tool, pass, ms: r.ms, note: r.ok ? "succeeded" : `${r.data?.code}: ${r.data?.error}` });
    console.log(`${pass ? "PASS" : "FAIL"}  ${title.padEnd(48)} ${String(r.ms).padStart(6)}ms  ${r.ok ? "unexpected success" : r.data?.code + " " + String(r.data?.error).slice(0, 120)}`);
    return r;
  }
  function record(title, pass, note = "") {
    results.push({ name: title, tool: "-", pass, ms: 0, note });
    console.log(`${pass ? "PASS" : "FAIL"}  ${title.padEnd(48)}          ${note.slice(0, 170)}`);
  }
  async function setup({ sequence = true, extra = [] } = {}) {
    const proj = path.join(dir, `${name}-${Date.now()}.prproj`);
    await step("new project", "project_file", { action: "new", path: proj }, (d) => (ctx.projectPath = d.path) && d.created);
    const files = ["clipA.mp4", "clipB.mp4", "still.png", "vo.wav", "talk.wav", "noaudio.mp4", "redblue.mp4", ...extra].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
    await step("import media", "import_media", { paths: files, bin: "Test" }, (d) => {
      for (const it of d.imported) if (!ctx[it.name]) ctx[it.name] = it.id;
      return d.count >= 4 && `${d.count} items`;
    });
    if (sequence) await step("create sequence", "create_sequence", { name: "S1", width: 1920, height: 1080, fps: 30 }, (d) => d.width === 1920);
  }
  async function finish() {
    await step("save project", "project_file", { action: "save" }, (d) => d.saved);
    const st = (await c.call("premiere_status", {})).data;
    if ((st.projects || []).length > 1) await step("close test project", "project_file", { action: "close", save: true }, (d) => d.closed);
    else console.log("      (test project left open: it is the only open project)");
    c.close();
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${name}: ${passed}/${results.length} passed`);
    fs.writeFileSync(path.join(dir, `${name}-results.json`), JSON.stringify(results, null, 1));
    return { passed, total: results.length };
  }
  const tl = async (args = {}) => (await c.call("get_timeline", args)).data;
  const clipsOn = async (track, args = {}) => ((await tl({ tracks: [track], ...args })).tracks.find((t) => t.track === track)?.clips || []);
  return { c, ctx, results, step, expectError, record, setup, finish, tl, clipsOn };
}
