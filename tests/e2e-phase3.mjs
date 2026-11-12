// Phase 3 (automatic edits) live tests on synthetic media (tests/make-media.mjs).
// Each feature: preview, then the real edit, verified by reading Premiere back.
// Usage: node tests/make-media.mjs && node tests/e2e-phase3.mjs [mediaDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { near, suite } from "./harness.mjs";

const DIR = path.resolve(process.argv[2] || "D:/mcp-plus-e2e");
const OUT = path.join(os.tmpdir(), "premiere-mcp-plus-e2e", "p3-" + Date.now());
fs.mkdirSync(OUT, { recursive: true });
const T = await suite("phase3", DIR);
const { c, ctx, step, expectError, record, tl, clipsOn } = T;
const only = (process.env.P3_ONLY || "").split(",").filter(Boolean);
const section = (n) => !only.length || only.includes(n);
const dur = async (sequence) => (await tl({ sequence, compact: true })).duration;
const seq = (name, w = 1920, h = 1080) => step(`sequence ${name}`, "create_sequence", { name, width: w, height: h, fps: 30 }, (d) => d.name === name);

await T.setup({ sequence: false, extra: ["speech.wav", "music.wav", "angleA.mp4", "angleB.mp4", "speakerA.wav", "speakerB.wav"] });

// ------------------------------------------------------------ 1 jump cut
if (section("jump_cut")) {
  await seq("JC");
  await step("speech + picture", "place_clips", () => ({ sequence: "JC", clips: [{ item: ctx["speech.wav"], track: "A1", start: 0, media: "audio" }, { item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 12, media: "video" }, { item: ctx["clipB.mp4"], track: "V1", start: 12, in: 0, out: 9, media: "video" }] }), (d) => d.placed.length === 3);
  await step("jump_cut preview", "auto_edit", { action: "jump_cut", sequence: "JC", preview: true }, (d) => d.preview && d.count >= 4 && (ctx.jc = d) && `${d.count} silences, ${d.seconds}s`);
  const before = await dur("JC");
  await step("jump_cut + zoom (checkpoint)", "auto_edit", { action: "jump_cut", sequence: "JC", zoom: 106, checkpoint: true }, async (d, r) => {
    const after = await dur("JC");
    return r.status === "verified" && near(before - after, d.seconds, 0.1) && d.zoomed >= 2 && d.checkpoint?.clone && `${before} -> ${after}s, zoomed ${d.zoomed}`;
  });
  await step("alternate clips at 106%", "get_clip_effects", { sequence: "JC", clips: { tracks: ["V1"] }, limit: 4 }, (d) => {
    const sc = d.clips.map((x) => x.components.find((k) => k.matchName === "AE.ADBE Motion").props.find((p) => p.name === "Scale").value);
    return near(sc[0], 100, 0.1) && near(sc[1], 106, 0.1) && sc.join(",");
  });
  await step("speech left intact (re-check silences)", "auto_edit", { action: "jump_cut", sequence: "JC", preview: true }, (d) => d.count <= 1 && `${d.count} left`);
}

// ------------------------------------------------------------ 2 fillers, pauses, repeated takes
if (section("fillers")) {
  await seq("FL");
  await step("speech + picture (FL)", "place_clips", () => ({ sequence: "FL", clips: [{ item: ctx["speech.wav"], track: "A1", start: 0, media: "audio" }, { item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 12, media: "video" }, { item: ctx["clipB.mp4"], track: "V1", start: 12, in: 0, out: 9, media: "video" }] }), (d) => d.placed.length === 3);
  await step("remove_fillers preview", "auto_edit", { action: "remove_fillers", sequence: "FL", language: "en", preview: true }, (d) => {
    const words = d.fillers.map((f) => f.word);
    return words.includes("um") && words.includes("uh") && d.repeatedTakes.length === 1 && `${words.join(",")}; takes ${d.repeatedTakes.length}; pauses ${d.pauses}`;
  });
  await step("remove_fillers", "auto_edit", { action: "remove_fillers", sequence: "FL", language: "en" }, (d, r) => r.status === "verified" && `${d.durationBefore} -> ${d.durationAfter}s`);
  await step("re-transcribe: no um/uh, one take", "transcribe", { sequence: "FL", clips: { tracks: ["A1"] }, language: "en" }, (d) => {
    const t = d.text.toLowerCase();
    return !/\bum\b|\buh\b/.test(t) && (t.match(/automatically/g) || []).length === 1 && d.text;
  });
}

// ------------------------------------------------------------ 3 beat montage
if (section("beats")) {
  await seq("BM");
  await step("music on A2", "place_clips", () => ({ sequence: "BM", clips: [{ item: ctx["music.wav"], track: "A2", start: 0, media: "audio" }] }), (d) => d.placed.length === 1);
  await step("beat_montage preview", "auto_edit", () => ({ action: "beat_montage", sequence: "BM", items: [ctx["clipA.mp4"], ctx["clipB.mp4"], ctx["redblue.mp4"]], preview: true }), (d) => near(d.bpm, 120, 3) && d.clips.length >= 8);
  await step("beat_montage every 2 beats", "auto_edit", () => ({ action: "beat_montage", sequence: "BM", items: [ctx["clipA.mp4"], ctx["clipB.mp4"], ctx["redblue.mp4"]], every: 2, transition: "Cross Dissolve" }), async (d, r) => {
    const v = await clipsOn("V1", { sequence: "BM" });
    const lens = v.slice(0, 6).map((x) => x.end - x.start);
    return r.status === "verified" && v.length >= 8 && lens.every((l) => near(l, 1, 0.07)) && `${v.length} clips, ${d.bpm} BPM`;
  });
}

// ------------------------------------------------------------ 4 emphasis zoom
if (section("emphasis")) {
  await seq("EZ");
  await step("speech + picture (EZ)", "place_clips", () => ({ sequence: "EZ", clips: [{ item: ctx["speech.wav"], track: "A1", start: 0, media: "audio" }, { item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 12, media: "video" }, { item: ctx["clipB.mp4"], track: "V1", start: 12, in: 0, out: 9, media: "video" }] }), (d) => d.placed.length === 3);
  await step("emphasis_zoom on keywords", "auto_edit", { action: "emphasis_zoom", sequence: "EZ", keywords: ["editing", "silence"], language: "en", zoom: 115 }, async (d, r) => {
    const fx = (await c.call("get_clip_effects", { sequence: "EZ", clips: { tracks: ["V1"] } })).data.clips;
    const keys = fx.flatMap((x) => x.components.find((k) => k.matchName === "AE.ADBE Motion").props.find((p) => p.name === "Scale").keyframes || []);
    return r.status === "verified" && d.points >= 3 && keys.some((k) => near(k.v, 115, 0.1)) && `${d.points} points at ${d.at.join(",")}`;
  });
  await step("emphasis_zoom on loudness peaks (preview)", "auto_edit", { action: "emphasis_zoom", sequence: "EZ", preview: true }, (d) => d.points.length >= 1);
}

// ------------------------------------------------------------ 5 multicam
if (section("multicam")) {
  await seq("MC");
  await step("two angles stacked", "place_clips", () => ({ sequence: "MC", clips: [{ item: ctx["angleA.mp4"], track: "V1", audio_track: "A1", start: 0 }, { item: ctx["angleB.mp4"], track: "V2", audio_track: "A2", start: 0 }] }), (d) => d.placed.length === 2);
  await step("multicam preview", "auto_edit", { action: "multicam", sequence: "MC", preview: true }, (d) => d.shots.length >= 4 && d.shots.map((s) => `${s.video}@${s.start}`).join(" "));
  await step("multicam cut", "auto_edit", { action: "multicam", sequence: "MC", min_shot: 1.5, checkpoint: true }, (d, r) => r.status === "verified" && d.switches >= 3);
  const at = async (t) => {
    const v1 = (await c.call("find_clips", { sequence: "MC", clips: { tracks: ["V1"], at: t } })).data.clips[0];
    const v2 = (await c.call("find_clips", { sequence: "MC", clips: { tracks: ["V2"], at: t } })).data.clips[0];
    return { a: v1 && !v1.disabled, b: v2 && !v2.disabled };
  };
  await step("A speaks at 1.5 s: angle A shown", "get_project", { compact: true }, async () => { const s = await at(1.5); return s.a && !s.b; });
  await step("B speaks at 5 s: angle B shown", "get_project", { compact: true }, async () => { const s = await at(5); return s.b && !s.a; });
  await step("A again at 8.5 s", "get_project", { compact: true }, async () => { const s = await at(8.5); return s.a && !s.b; });
}

// ------------------------------------------------------------ 6 speaker reframe
if (section("reframe")) {
  await seq("RF", 1080, 1920);
  await step("wide clip + speaker audio", "place_clips", () => ({ sequence: "RF", clips: [{ item: ctx["angleA.mp4"], track: "V1", start: 0, media: "video" }, { item: ctx["speakerA.wav"], track: "A1", start: 0, media: "audio" }, { item: ctx["speakerB.wav"], track: "A2", start: 0, media: "audio" }] }), (d) => (ctx.rf = d.placed[0].id));
  await step("speaker_reframe by audio", "auto_edit", () => ({ action: "speaker_reframe", sequence: "RF", clips: ctx.rf, method: "audio", speakers: [{ x: 320, audio: { tracks: ["A1"] } }, { x: 960, audio: { tracks: ["A2"] } }] }), async (d, r) => {
    const m = (await c.call("get_clip_effects", { sequence: "RF", clips: ctx.rf })).data.clips[0].components.find((k) => k.matchName === "AE.ADBE Motion");
    const pos = m.props.find((p) => p.name === "Position").keyframes;
    const xs = [...new Set(pos.map((k) => Math.round(k.v[0] * 1080)))];
    return r.status === "verified" && pos.length >= 6 && xs.length >= 2 && `${pos.length} keys, x ${xs.join("/")}`;
  });
  await step("speaker_reframe by frames (preview)", "auto_edit", () => ({ action: "speaker_reframe", sequence: "RF", clips: ctx.rf, method: "frames", preview: true }), (d) => d.keys >= 20 && near(d.scale, 266.667, 0.5));
}

// ------------------------------------------------------------ 7 shorts
if (section("shorts")) {
  await seq("LONG");
  await step("long source", "place_clips", () => ({ sequence: "LONG", clips: [{ item: ctx["angleA.mp4"], track: "V1", audio_track: "A1", start: 0 }] }), (d) => d.placed.length === 1);
  await step("shorts preview", "auto_edit", { action: "shorts", sequence: "LONG", length: 5, count: 2, language: "en", preview: true }, (d) => d.candidates.length === 2);
  await step("shorts build x2 with captions + CTA", "auto_edit", { action: "shorts", sequence: "LONG", length: 5, count: 2, cta: "INSCREVA-SE", language: "en" }, async (d, r) => {
    const s1 = d.shorts[0];
    const v3 = await clipsOn("V3", { sequence: s1.sequence });
    const v1 = await clipsOn("V1", { sequence: s1.sequence });
    const set = (await c.call("manage_sequence", { action: "get_settings", sequence: s1.sequence })).data;
    return r.status === "verified" && d.shorts.length === 2 && set.width === 1080 && set.height === 1920 && v1.length === 1 && v3.length === 1 && s1.captions > 0 && `${d.shorts.map((x) => `${x.start}-${x.end} (${x.captions} cards)`).join("; ")}`;
  });
}

// ------------------------------------------------------------ 8 chapters
if (section("chapters")) {
  await seq("CH");
  await step("speech (CH)", "place_clips", () => ({ sequence: "CH", clips: [{ item: ctx["speech.wav"], track: "A1", start: 0, media: "audio" }, { item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 12, media: "video" }] }), (d) => d.placed.length === 2);
  await step("chapters from transcript", "auto_edit", { action: "chapters", sequence: "CH", language: "en", count: 3, min_length: 4 }, async (d, r) => {
    const ms = (await c.call("markers", { action: "list", sequence: "CH", type: "chapter" })).data;
    return r.status === "verified" && ms.count === d.chapters.length && d.chapters.length >= 3 && /^00:00 /.test(d.text) && d.text.replace(/\n/g, " | ");
  });
}

// ------------------------------------------------------------ 9 mix
if (section("mix")) {
  await seq("MX");
  await step("voice + music", "place_clips", () => ({ sequence: "MX", clips: [{ item: ctx["speech.wav"], track: "A1", start: 0, media: "audio" }, { item: ctx["music.wav"], track: "A2", start: 0, media: "audio" }] }), (d) => d.placed.length === 2);
  await step("mix -16 voice / ducking / -14 LUFS", "auto_edit", { action: "mix", sequence: "MX" }, (d, r) => r.status === "verified" && d.ducking >= 1 && `before ${d.before.lufs} LUFS / ${d.before.truePeak} dBTP -> after ${d.after.lufs} / ${d.after.truePeak}`);
}

// ------------------------------------------------------------ 10 sync external audio
if (section("sync")) {
  await seq("SY");
  await step("camera clip at 2 s", "place_clips", () => ({ sequence: "SY", clips: [{ item: ctx["angleA.mp4"], track: "V1", audio_track: "A1", start: 2 }] }), (d) => d.placed.length === 1);
  await step("sync_audio external wav", "auto_edit", { action: "sync_audio", sequence: "SY", file: path.join(DIR, "sync_ext.wav"), track: "A3" }, async (d, r) => {
    const a3 = await clipsOn("A3", { sequence: "SY" });
    return r.status === "verified" && near(d.offset, -1.25, 0.05) && a3.length === 1 && near(a3[0].start, 2, 0.04) && near(a3[0].in, 1.25, 0.05) && `offset ${d.offset}, conf ${d.confidence}`;
  });
}

// ------------------------------------------------------------ 11 visual QA
if (section("qa")) {
  await seq("QA");
  await step("material with problems", "place_clips", () => ({ sequence: "QA", clips: [{ item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 3, media: "video" }, { item: ctx["clipB.mp4"], track: "V1", start: 4, in: 0, out: 3, media: "video", enabled: false }] }), (d) => d.placed.length === 2);
  await step("visual_qa", "auto_edit", { action: "visual_qa", sequence: "QA" }, (d, r) => r.images.length === 1 && d.byType.gap >= 1 && d.byType.disabled_clip === 1 && d.issues.every((i) => /^\d\d:\d\d:\d\d:\d\d$/.test(i.timecode)) && JSON.stringify(d.byType));
}

// ------------------------------------------------------------ 12 recipes
if (section("recipes")) {
  await step("recipes list has canal_padrao", "recipes", { action: "list" }, (d) => d.recipes.some((r) => r.name === "canal_padrao"));
  await step("recipes save", "recipes", { action: "save", name: "teste_marcas", description: "markers + playhead", params: { t: 2 }, steps: [{ tool: "markers", args: { action: "add", markers: [{ time: "{{t}}", name: "R1" }] } }, { tool: "playhead", args: { seconds: "{{t}}" }, save: "ph" }, { tool: "markers", args: { action: "add", markers: [{ time: 3, name: "ph={{steps.ph.playhead}}" }] } }] }, (d, r) => r.status === "verified");
  await seq("RC");
  await step("recipes run", "recipes", { action: "run", name: "teste_marcas", sequence: "RC", params: { t: 2 } }, async (d, r) => {
    const ms = (await c.call("markers", { action: "list", sequence: "RC" })).data.markers;
    return d.completed && ms.some((m) => m.name === "R1" && near(m.start, 2)) && ms.some((m) => m.name === "ph=2");
  });
  const pr = await c.req("prompts/list", {});
  record("recipes exposed as MCP prompts", (pr.result?.prompts || []).some((p) => p.name === "recipe_canal_padrao"), (pr.result?.prompts || []).map((p) => p.name).join(","));
  const rr = await c.req("resources/read", { uri: "premiere-plus://recipes" });
  record("recipes catalog resource", /canal_padrao/.test(rr.result?.contents?.[0]?.text || ""), "premiere-plus://recipes");
  await seq("CP");
  await step("voice + music for canal_padrao", "place_clips", () => ({ sequence: "CP", clips: [{ item: ctx["speech.wav"], track: "A1", start: 0, media: "audio" }, { item: ctx["music.wav"], track: "A2", start: 0, media: "audio" }, { item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 12, media: "video" }, { item: ctx["clipB.mp4"], track: "V1", start: 12, in: 0, out: 9, media: "video" }] }), (d) => d.placed.length === 4);
  await step("run canal_padrao (job)", "recipes", { action: "run", name: "canal_padrao", sequence: "CP", params: { language: "en" }, async: true }, (d) => (ctx.rj = d.job_id));
  await step("canal_padrao finished", "jobs", () => ({ action: "wait", job_id: ctx.rj, timeout_s: 600 }), async (d) => {
    const v3 = await clipsOn("V3", { sequence: "CP" });
    return d.state === "done" && d.result.completed && v3.length > 5 && d.result.results.map((x) => `${x.tool}:${x.ok ? "ok" : x.skipped ? "skip" : "fail"}`).join(" ");
  });
}

// ------------------------------------------------------------ 13 paper edit
if (section("paper")) {
  await seq("PE");
  await step("transcribe the recording", "transcribe", { file: path.join(DIR, "speech.wav"), language: "en" }, (d) => (ctx.ptr = d.transcript));
  await step("paper_edit in script order", "auto_edit", () => ({ action: "paper_edit", sequence: "PE", transcript: ctx.ptr, item: ctx["speech.wav"], script: ["Thanks for watching", "Welcome to the channel", "today we talk about editing"], name: "Paper" }), async (d, r) => {
    const a1 = await clipsOn("A1", { sequence: "Paper" });
    return r.status === "verified" && a1.length === 3 && a1[0].in > 17 && a1[1].in < 0.5 && a1[2].in > 3.5 && a1[2].in < 4.5 && a1.map((x) => `${x.in}-${x.out}`).join(" ");
  });
}

await T.finish();
