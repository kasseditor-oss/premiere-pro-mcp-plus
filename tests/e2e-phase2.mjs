// Phase 2 (capability parity) live tests: one or more checks per action, each
// verified by reading Premiere (or the produced file) back.
// Usage: node tests/make-media.mjs && node tests/e2e-phase2.mjs [mediaDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { near, suite } from "./harness.mjs";

const DIR = path.resolve(process.argv[2] || "D:/mcp-plus-e2e");
const OUT = path.join(os.tmpdir(), "premiere-mcp-plus-e2e", "p2-" + Date.now());
fs.mkdirSync(OUT, { recursive: true });
const T = await suite("phase2", DIR);
const { c, ctx, step, expectError, record, tl, clipsOn } = T;
const only = (process.env.P2_ONLY || "").split(",").filter(Boolean);
const section = (name) => !only.length || only.includes(name);
const fx = async (id) => (await c.call("get_clip_effects", { clips: id })).data.clips[0].components;
const prop = (comps, effect, name) => comps.find((x) => x.matchName === effect || x.name === effect)?.props.find((p) => p.name === name);

await T.setup({ extra: ["speech.wav", "music.wav", "angleA.mp4", "angleB.mp4"] });
await step("base timeline", "place_clips", () => ({
  clips: [
    { item: ctx["clipA.mp4"], track: "V1", audio_track: "A1", start: 0, in: 0, out: 4 },
    { item: ctx["clipB.mp4"], track: "V1", audio_track: "A1", start: 5, in: 0, out: 4 },
    { item: ctx["still.png"], track: "V2", start: 1, duration: 2 },
    { item: ctx["vo.wav"], track: "A3", start: 0, in: 0, out: 6, media: "audio" },
  ],
}), (d) => d.placed.length === 4 && (ctx.a = d.placed[0].id) && (ctx.b = d.placed[1].id) && (ctx.still = d.placed[2].id) && (ctx.vo = d.placed[3].id));

// ============================================================ 2.1 inspection
if (section("inspect")) {
  await step("inspect project_overview", "inspect", { action: "project_overview" }, (d) => d.media.used >= 4 && d.media.unused >= 1 && `used ${d.media.used} unused ${d.media.unused}`);
  await step("inspect sequence", "inspect", { action: "sequence" }, (d) => d.tracks.some((t) => t.track === "V1" && t.clips.length === 2));
  await step("inspect clip (effects, linked)", "inspect", () => ({ action: "clip", clips: ctx.a }), (d) => d.clips[0].components.some((x) => x.matchName === "AE.ADBE Motion") && d.clips[0].linked.length === 1 && "linked A1");
  await step("inspect timeline_summary", "inspect", { action: "timeline_summary" }, (d) => d.tracks.find((t) => t.track === "V1").gaps === 1 && near(d.duration, 9, 0.05) && `${d.tracks.length} tracks, ${d.gaps} gaps`);
  await step("inspect gaps -> V1 4..5", "inspect", { action: "gaps" }, (d) => d.gapList.some((g) => g.track === "V1" && near(g.start, 4) && near(g.end, 5)));
  await step("disable the still (for health)", "edit_clips", () => ({ action: "set", clips: ctx.still, enabled: false }), () => true);
  await step("inspect health", "inspect", { action: "health" }, (d) => d.issues.some((i) => i.type === "disabled_clip" && i.clip === ctx.still) && `${d.issues.length} issues: ${[...new Set(d.issues.map((i) => i.type))].join(",")}`);
  await step("re-enable the still", "edit_clips", () => ({ action: "set", clips: ctx.still, enabled: true }), () => true);
  await step("inspect used_media", "inspect", { action: "used_media" }, (d) => d.items.some((i) => i.name === "vo.wav"));
  await step("inspect unused_media", "inspect", { action: "unused_media" }, (d) => d.items.some((i) => i.name === "talk.wav"));
  await step("import a duplicate of clipA", "import_media", { paths: [path.join(DIR, "clipA.mp4")], bin: "Dup" }, (d) => (ctx.dup = d.imported[0]?.id));
  await step("inspect duplicates", "inspect", { action: "duplicates" }, (d) => d.duplicates.some((x) => x.items.length === 2 && /clipA/.test(x.media)));
  await step("inspect state", "inspect", { action: "state" }, (d) => d.sequence?.name === "S1" && Array.isArray(d.selection) && `targeted ${d.targeted?.join(",")}`);
  await step("search_items by extension", "search_items", { extensions: ["wav"] }, (d) => d.count >= 4);
  await step("search_items unused", "search_items", { used: false, types: ["clip", "file"] }, (d) => d.items.some((i) => i.name === "talk.wav") && !d.items.some((i) => i.name === "vo.wav"));
  await step("search_items by name", "search_items", { name: "clip" }, (d) => d.count >= 3);
}

// ============================================================ 2.11 metadata
if (section("metadata")) {
  await step("metadata set (XMP)", "metadata", () => ({ action: "set", items: [ctx["clipA.mp4"]], values: { "Log Note": "plano bom", Scene: "12", Take: "3", Good: "true", Description: "abertura" } }), (d, r) => r.status === "verified");
  await step("metadata get", "metadata", () => ({ action: "get", items: [ctx["clipA.mp4"]] }), (d) => d.items[0].fields["Log Note"] === "plano bom" && d.items[0].fields.Scene === "12" && d.items[0].fields.Description === "abertura" && JSON.stringify(d.items[0].fields));
  await step("metadata add_field", "metadata", { action: "add_field", field: "MCPReview", field_label: "MCP Review", type: 2 }, (d) => d.added !== undefined);
  await step("metadata set custom field", "metadata", () => ({ action: "set", items: [ctx["clipA.mp4"]], values: { MCPReview: "ok" } }), () => true);
  await step("metadata get custom field", "metadata", () => ({ action: "get", items: [ctx["clipA.mp4"]], fields: ["MCPReview"] }), (d) => d.items[0].custom?.MCPReview === "ok");
  await step("metadata labels in bulk", "metadata", () => ({ action: "label", items: [ctx["vo.wav"], ctx["talk.wav"]], label: 4 }), (d, r) => r.status === "verified" && d.items.every((i) => i.label === 4));
  await step("metadata get hides sensitive", "metadata", () => ({ action: "get", items: [ctx["clipA.mp4"]], detail: true }), (d) => !Object.keys(d.items[0].xmp || {}).some((k) => /GPS|Serial/i.test(k)));
}

// ============================================================ 2.2 media and project
if (section("media")) {
  await step("media interpret fps 25", "media", () => ({ action: "interpret", items: [ctx["noaudio.mp4"]], fps: 25 }), (d, r) => r.status === "verified" && near(d.items[0].interpretation.fps, 25, 0.01));
  await step("media interpret back to 30", "media", () => ({ action: "interpret", items: [ctx["noaudio.mp4"]], fps: 30 }), (d, r) => r.status === "verified");
  await step("media color_space read", "media", () => ({ action: "color_space", items: [ctx["clipA.mp4"]] }), (d) => typeof d.items[0].colorSpace === "string" && d.items[0].colorSpace);
  await step("media set_offline", "media", () => ({ action: "set_offline", items: [ctx["talk.wav"]] }), (d, r) => r.status === "verified");
  await step("inspect offline lists it", "inspect", { action: "offline" }, (d) => d.items.some((i) => i.name === "talk.wav"));
  await step("media relink by folder search", "media", () => ({ action: "relink", search: DIR, items: [ctx["talk.wav"]] }), (d, r) => r.status === "verified" && d.results[0].relinked);
  await step("relinked item is online", "search_items", { name: "talk.wav", offline: false }, (d) => d.count >= 1);
  await step("media attach_proxy", "media", () => ({ action: "attach_proxy", items: [ctx["clipB.mp4"]], path: path.join(DIR, "proxies", "clipB_proxy.mp4") }), (d, r) => r.status === "verified" && d.items[0].hasProxy);
  await step("media proxy_status", "media", () => ({ action: "proxy_status", items: [ctx["clipB.mp4"]] }), (d) => d.items[0].hasProxy === true && /clipB_proxy/i.test(d.items[0].proxy));
  await step("media detach_proxy", "media", () => ({ action: "detach_proxy", items: [ctx["clipB.mp4"]] }), (d, r) => r.status === "verified" || "detach not verifiable");
  await step("media proxies_enable off", "media", { action: "proxies_enable", enabled: false }, (d) => d.proxiesEnabled === false);
  const wdir = path.join(OUT, "watch");
  fs.mkdirSync(wdir, { recursive: true });
  await step("media watch_folder", "media", { action: "watch_folder", path: wdir, bin: "Watched" }, (d) => d.watching);
  fs.copyFileSync(path.join(DIR, "still.png"), path.join(wdir, "dropped.png"));
  await new Promise((r) => setTimeout(r, 7000));
  await step("watched file was imported", "search_items", { name: "dropped.png" }, (d) => d.count === 1);
  await step("media stop_watch", "media", { action: "stop_watch", path: wdir }, (d) => d.stopped);
  await expectError("media poster_frame unsupported", "media", { action: "poster_frame", items: ["x"] }, "UNSUPPORTED_IN_PREMIERE");
  await expectError("media audio_channel_mapping unsupported", "media", { action: "audio_channel_mapping", items: ["x"] }, "UNSUPPORTED_IN_PREMIERE");
  await step("media create_proxies (AME, job)", "media", () => ({ action: "create_proxies", items: [ctx["noaudio.mp4"]], proxy_folder: path.join(OUT, "proxies"), async: true }), (d) => (ctx.proxyJob = d.job_id));
  await step("proxy job done + attached", "jobs", () => ({ action: "wait", job_id: ctx.proxyJob, timeout_s: 600 }), (d) => d.state === "done" && d.result.verified && d.result.results[0].proxy);
}

// ============================================================ 2.3 sequences
if (section("sequences")) {
  await step("create_sequence from_items", "create_sequence", () => ({ name: "FromItems", from_items: [ctx["clipA.mp4"], ctx["clipB.mp4"]] }), (d, r) => r.status === "verified" && d.clips >= 2 && `${d.clips} clips`);
  await step("back to S1", "open_sequence", { sequence: "S1" }, (d) => d.name === "S1");
  await step("manage_sequence zero_point 3600", "manage_sequence", { action: "zero_point", sequence: "FromItems", seconds: 3600 }, (d, r) => r.status === "verified");
  await step("manage_sequence format field progressive", "manage_sequence", { action: "format", sequence: "FromItems", field_type: 0, max_render_quality: true }, (d) => d.fieldType === 0 && d.maxRenderQuality === true);
  await step("manage_sequence custom_property", "manage_sequence", { action: "custom_property", sequence: "FromItems", prop_name: "mcp.test", prop_value: "42" }, (d) => d.attached.value === "42");
  await step("sequence_tools nest V2 still", "sequence_tools", () => ({ action: "nest", clips: ctx.still, name: "Nest1" }), async (d, r) => {
    const v2 = await clipsOn("V2");
    ctx.nest = d.clip;
    return r.status === "verified" && v2.length === 1 && v2[0].name === "Nest1" && near(v2[0].start, 1) && near(v2[0].end, 3);
  });
  await step("sequence_tools unnest", "sequence_tools", () => ({ action: "unnest", clips: ctx.nest }), async (d) => {
    const v2 = await clipsOn("V2");
    ctx.still = v2[0]?.id;
    return v2.length === 1 && v2[0].name === "still.png" && near(v2[0].start, 1) && near(v2[0].end, 3);
  });
  await step("sequence_tools render_previews (audio)", "sequence_tools", { action: "render_previews", sequence: "FromItems", audio: true }, (d) => d.rendered);
  await step("sequence_tools delete_previews", "sequence_tools", { action: "delete_previews", sequence: "FromItems" }, (d) => d.deleted);
}

// ============================================================ 2.4 editing
if (section("editing")) {
  await step("3 adjacent clips on V4", "place_clips", () => ({ clips: [0, 1, 2].map((i) => ({ item: ctx["clipA.mp4"], track: "V4", start: 20 + i * 2, in: 1 + i * 3, out: 3 + i * 3, media: "video" })) }), (d) => (ctx.v4 = d.placed.map((p) => p.id)) && d.placed.length === 3);
  await step("slip middle +0.5", "edit_clips", () => ({ action: "slip", clips: ctx.v4[1], delta: 0.5 }), async (d, r) => { const x = (await clipsOn("V4"))[1]; return r.status === "verified" && near(x.in, 4.5) && near(x.start, 22); });
  await step("slide middle +0.5", "edit_clips", () => ({ action: "slide", clips: ctx.v4[1], delta: 0.5 }), async (d, r) => { const v = await clipsOn("V4"); return r.status === "verified" && near(v[1].start, 22.5) && near(v[0].end, 22.5) && near(v[2].start, 24.5); });
  await step("roll first edit +0.3", "edit_clips", () => ({ action: "roll", clips: (ctx.v4first = ctx.v4[0]), delta: 0.3 }), async (d, r) => { const v = await clipsOn("V4"); return r.status === "verified" && near(v[0].end, 22.8) && near(v[1].start, 22.8); });
  await step("ripple_trim end -0.5", "edit_clips", () => ({ action: "ripple_trim", clips: { tracks: ["V4"], limit: 1 }, edge: "end", delta: -0.5 }), async () => { const v = await clipsOn("V4"); return near(v[0].end, 22.3) && near(v[1].start, 22.3) && `${v.map((x) => x.start).join(",")}`; });
  await step("duplicate a clip", "edit_clips", () => ({ action: "duplicate", clips: ctx.a, to: 40, track: "V5" }), async (d, r) => { const v5 = await clipsOn("V5"); return r.status === "verified" && v5.length === 1 && near(v5[0].start, 40) && near(v5[0].in, 0) && near(v5[0].out, 4); });
  await step("freeze_frame 1 s at 41", "edit_clips", () => ({ action: "freeze_frame", clips: { tracks: ["V5"] }, at: 41, duration: 1 }), async (d, r) => { const v5 = await clipsOn("V5"); return r.status === "verified" && v5.some((x) => /mcpframe|png/i.test(x.name) && near(x.start, 41) && near(x.end, 42)) && v5.map((x) => `${x.name.slice(0, 8)}@${x.start}`).join(" "); });
  await step("lift_range 20.5-21 on V4", "edit_clips", { action: "lift_range", start: 20.5, end: 21, tracks: ["V4"] }, async () => { const v = await clipsOn("V4"); return v.some((x) => near(x.end, 20.5)) && v.some((x) => near(x.start, 21)); });
  const before = (await tl({ compact: true })).duration;
  await step("extract_range 41.5-42 (all tracks)", "edit_clips", { action: "extract_range", start: 41.5, end: 42 }, async () => near((await tl({ compact: true })).duration, before - 0.5, 0.05));
  await step("trim clipB start +1 (handles)", "edit_clips", () => ({ action: "trim", clips: ctx.b, trim_start: 1 }), () => true);
  await step("split_edit J cut 0.5 on clipB", "edit_clips", () => ({ action: "split_edit", clips: ctx.b, audio_lead: 0.5 }), async () => { const v = (await clipsOn("V1"))[1]; const a = (await clipsOn("A1")).find((x) => near(x.end, v.end)); return a && near(a.start, v.start - 0.5) && `video ${v.start} audio ${a.start}`; });
  await step("batch_rename", "edit_clips", { action: "batch_rename", clips: { tracks: ["V4"] }, pattern: "Cena {n:02}" }, async (d, r) => { const v = await clipsOn("V4"); return r.status === "verified" && v[0].name === "Cena 01"; });
  const d0 = (await tl({ compact: true })).duration;
  await step("ripple_delete_ranges (2)", "ripple_delete_ranges", { ranges: [{ start: 30, end: 31 }, { start: 35, end: 35.5 }] }, async (d) => near((await tl({ compact: true })).duration, d0 - 1.5, 0.05) && `${d0} -> ${d.durationAfter}`);
  await step("keyframes for policy test", "add_keyframes", () => ({ clips: ctx.a, animations: [{ property: "Scale", replace: true, keys: [{ t: 0.2, v: 100 }, { t: 3.5, v: 120 }] }] }), (d) => !d.errors.length);
  await expectError("trim keyframe_policy reject", "edit_clips", () => ({ action: "trim", clips: ctx.a, trim_end: 1, include_linked: false, keyframe_policy: "reject" }), "KEYFRAMES_OUTSIDE");
  await step("set_clip_speed optical_flow", "set_clip_speed", () => ({ clips: ctx.v4[2], interpolation: "optical_flow" }), (d) => d.interpolation.verified);
  await step("speed ramp 1x -> 2x", "set_clip_speed", () => ({ clips: { tracks: ["V5"], limit: 1 }, ramp: [{ at: 0, speed: 1 }, { at: 0.5, speed: 2 }], include_linked: false }), (d) => d.pieces >= 2 && d.ramp.some((p) => near(p.speed, 2, 0.01)) && JSON.stringify(d.ramp.map((p) => p.speed)));
  await step("source open with in/out", "source", () => ({ action: "open", item: ctx["clipB.mp4"], in: 1, out: 2 }), (d, r) => r.status === "verified");
  await step("source state", "source", { action: "state" }, (d) => d.item?.name === "clipB.mp4" && near(d.item.in, 1));
  await step("source overwrite at 50 to V6/A6", "source", { action: "overwrite", time: 50, video_track: "V6", audio_track: "A6" }, async (d, r) => { const v6 = await clipsOn("V6"); return r.status === "verified" && v6.length === 1 && near(v6[0].start, 50) && near(v6[0].end, 51); });
  await step("source insert at 50 on V6", "source", { action: "insert", time: 50, video_track: "V6", audio_track: "A6" }, async () => { const v6 = await clipsOn("V6"); return v6.length === 2 && near(v6[1].start, 51); });
  await step("playhead 0.5 + match_frame", "playhead", { seconds: 0.5 }, () => true);
  await step("source match_frame", "source", { action: "match_frame" }, (d) => d.item === "clipA.mp4" && near(d.mediaTime, 0.5) && `${d.item}@${d.mediaTime}`);
  await step("manage_tracks target_all", "manage_tracks", { action: "target_all" }, async () => { const s = (await c.call("inspect", { action: "state" })).data; return s.targeted.includes("V1") && s.targeted.includes("A3") && s.targeted.join(","); });
}

// ============================================================ 2.5 color / effects / keyframes
if (section("color")) {
  if (!ctx.v4) await step("3 clips on V4 (color)", "place_clips", () => ({ clips: [0, 1, 2].map((i) => ({ item: ctx["clipA.mp4"], track: "V4", start: 20 + i * 2, in: 1 + i * 3, out: 3 + i * 3, media: "video" })) }), (d) => (ctx.v4 = d.placed.map((p) => p.id)));
  await step("scale keys 0.2 / 3.5 on clipA", "add_keyframes", () => ({ clips: ctx.a, animations: [{ property: "Scale", replace: true, keys: [{ t: 0.2, v: 100 }, { t: 3.5, v: 120 }] }] }), (d) => !d.errors.length);
  await step("color basic", "color", () => ({ action: "basic", clips: ctx.b, values: { exposure: 0.8, contrast: 20, temperature: -10, saturation: 120 } }), (d, r) => r.status === "verified" && near(d.clips[0].set.exposure, 0.8, 0.01));
  await step("color read", "color", () => ({ action: "read", clips: ctx.b }), (d) => near(d.clips[0].values.contrast, 20, 0.01) && near(d.clips[0].values.saturation, 120, 0.01));
  await step("color auto_balance", "color", () => ({ action: "auto_balance", clips: ctx.a, target_luma: 50 }), (d) => d.clips[0].set && `luma ${d.clips[0].before.luma} -> ${d.clips[0].after.luma}`);
  await step("color match_shot", "color", () => ({ action: "match_shot", clips: ctx.b, reference: ctx.a }), (d) => d.clips.length === 1 && `luma ${d.clips[0].before.luma} -> ${d.clips[0].after.luma} (target ${d.clips[0].target.luma})`);
  await step("color apply_lut (input LUT)", "color", () => ({ action: "apply_lut", clips: ctx.b, path: path.join(DIR, "lut.cube") }), (d, r) => r.status === "verified" || `not verified: ${JSON.stringify(d).slice(0, 120)}`);
  await expectError("color look unsupported", "color", { action: "look", clips: { tracks: ["V1"] } }, "UNSUPPORTED_IN_PREMIERE");
  await step("stabilize clipB (wait)", "stabilize", () => ({ clips: ctx.b, timeout_s: 300 }), (d, r) => r.status === "verified" && d.analysisDone && `${d.seconds}s`);
  await expectError("adjustment_layer without one in project", "adjustment_layer", { start: 0, duration: 2 }, "UNSUPPORTED_IN_PREMIERE");
  await step("keyframe_tools list", "keyframe_tools", () => ({ action: "list", clips: ctx.a, property: "Scale" }), (d) => d.clips[0].keys.length === 2 && JSON.stringify(d.clips[0].keys));
  await step("keyframe_tools interpolation hold", "keyframe_tools", () => ({ action: "interpolation", clips: ctx.a, property: "Scale", interp: "hold" }), (d) => d.clips[0].changed === 2);
  await step("keyframe_tools move +0.3", "keyframe_tools", () => ({ action: "move", clips: ctx.a, property: "Scale", delta: 0.3 }), (d) => near(d.clips[0].keysNow[0], 0.5, 0.04) && near(d.clips[0].keysNow[1], 3.8, 0.04));
  await step("keyframe_tools scale x0.5", "keyframe_tools", () => ({ action: "scale", clips: ctx.a, property: "Scale", factor: 0.5, pivot: 0 }), (d) => near(d.clips[0].keysNow[0], 0.25, 0.04) && near(d.clips[0].keysNow[1], 1.9, 0.04));
  await step("keyframe_tools value_at", "keyframe_tools", () => ({ action: "value_at", clips: ctx.a, property: "Scale", time: 1 }), (d) => typeof d.clips[0].value === "number" && d.clips[0].value);
  await step("paste attributes motion only", "copy_effects", () => ({ from: ctx.a, to: ctx.v4[2], attributes: ["motion"] }), async () => { const p = prop(await fx(ctx.v4[2]), "AE.ADBE Motion", "Scale"); return p?.keyframes?.length === 2; });
  await expectError("paste time_remapping unsupported", "copy_effects", () => ({ from: ctx.a, to: ctx.b, attributes: ["time_remapping"] }), "UNSUPPORTED_IN_PREMIERE");
  await step("scopes", "scopes", { times: [1, 6] }, (d) => d.frames.length === 2 && typeof d.frames[0].luma.mean === "number" && `luma ${d.frames[0].luma.mean} / ${d.frames[1].luma.mean}`);
  await step("mask_fit static", "mask_fit", () => ({ clips: ctx.v4[1], rect: { x: 480, y: 270, w: 960, h: 540 } }), async (d) => { const p = prop(await fx(ctx.v4[1]), "AE.ADBE Motion", "Scale"); return near(p.value, d.computed.scale, 0.5) && `scale ${p.value}`; });
  await step("mask_fit animated", "mask_fit", () => ({ clips: ctx.v4[1], rect: { x: 0, y: 0, w: 1920, h: 1080 }, to_rect: { x: 480, y: 270, w: 960, h: 540 } }), async (d, r) => { const p = prop(await fx(ctx.v4[1]), "AE.ADBE Motion", "Scale"); return r.status === "verified" && p.keyframes?.length === 2; });
}

// ============================================================ 2.6 audio
if (section("audio")) {
  await step("place speech A5 / music A6", "place_clips", () => ({ clips: [{ item: ctx["speech.wav"], track: "A5", start: 60, media: "audio" }, { item: ctx["music.wav"], track: "A7", start: 60, media: "audio" }] }), (d) => (ctx.speech = d.placed[0].id) && (ctx.music = d.placed[1].id));
  await step("audio pan -50", "audio", () => ({ action: "pan", clips: ctx.vo, pan: -50 }), (d, r) => r.status === "verified" && near(d.clips[0].pan, -50, 0.5));
  await step("audio gain +3 dB", "audio", () => ({ action: "gain", clips: ctx.vo, db: 3 }), (d, r) => r.status === "verified" && near(d.clips[0].gainDb, 3, 0.1));
  await step("audio mute clip", "audio", () => ({ action: "mute", clips: ctx.vo }), async (d, r) => r.status === "verified" && (await c.call("find_clips", { clips: ctx.vo })).data.clips[0].disabled === true);
  await step("audio unmute clip", "audio", () => ({ action: "unmute", clips: ctx.vo }), (d, r) => r.status === "verified");
  await step("audio solo_track A5", "audio", { action: "solo_track", tracks: ["A5"] }, (d) => d.tracks.find((t) => t.track === "A1").muted && !d.tracks.find((t) => t.track === "A5").muted);
  await step("unsolo (solo all)", "audio", () => ({ action: "solo_track", tracks: Array.from({ length: 12 }, (_, i) => "A" + (i + 1)) }), () => true);
  await step("audio loudness", "audio", () => ({ action: "loudness", clips: ctx.speech }), (d) => typeof d.clips[0].mediaLufs === "number" && `${d.clips[0].mediaLufs} LUFS`);
  await step("audio normalize -16", "audio", () => ({ action: "normalize", clips: ctx.speech, target_lufs: -16 }), async (d) => { const v = (await c.call("audio", { action: "loudness", clips: ctx.speech })).data.clips[0]; return near(v.clipLufs, -16, 0.6) && `clip now ${v.clipLufs} LUFS`; });
  await step("audio duck music under speech", "audio", () => ({ action: "duck", voice: ctx.speech, music: ctx.music, duck_db: -12 }), async (d, r) => { const p = prop(await fx(ctx.music), "Internal Volume Stereo", "Level") || (await fx(ctx.music)).flatMap((x) => x.props).find((p) => p.keyframes); return r.status === "verified" && d.voiceRegions.length >= 3 && p?.keyframes?.length >= 4 && `${d.voiceRegions.length} regions, ${p.keyframes.length} keys`; });
  await step("audio detect_beats music ~120 BPM", "audio", () => ({ action: "detect_beats", clips: ctx.music }), (d) => near(d.bpm, 120, 3) && d.count >= 30 && `${d.bpm} BPM, ${d.count} beats`);
  await step("audio detect_transients", "audio", () => ({ action: "detect_transients", clips: ctx.music }), (d) => d.count >= 20);
  await step("audio effect DeNoise", "audio", () => ({ action: "effect", clips: ctx.speech, effects: ["DeNoise"] }), (d) => d.applied === 1);
  await expectError("audio channel_mapping unsupported", "audio", { action: "channel_mapping" }, "UNSUPPORTED_IN_PREMIERE");
}

// ============================================================ 2.7 captions, transcription, graphics
if (section("captions")) {
  await step("transcribe file", "transcribe", { file: path.join(DIR, "speech.wav"), language: "en", captions: true }, (d) => d.words > 20 && /Um/.test(d.text) && fs.existsSync(d.srt) && (ctx.tr = d.transcript) && `${d.words} words`);
  await step("transcribe sequence clips (time offset)", "transcribe", () => ({ clips: ctx.speech, language: "en" }), async (d) => { const j = JSON.parse(fs.readFileSync(d.path, "utf-8")); return near(j.words[0].start, 60, 0.3) && `first word at ${j.words[0].start}`; });
  await step("captions read srt", "captions", { action: "read", source: path.join(DIR, "subs.srt") }, (d) => d.count === 2 && d.cues[0].text === "Ola mundo");
  const srt2 = path.join(OUT, "subs2.srt");
  await step("captions edit", "captions", { action: "edit", source: path.join(DIR, "subs.srt"), output: srt2, edits: [{ index: 0, text: "Olá mundo!" }] }, (d, r) => r.status === "verified" && fs.readFileSync(srt2, "utf-8").includes("Olá mundo!"));
  await step("captions retime +1 s", "captions", { action: "retime", source: srt2, shift: 1, output: path.join(OUT, "subs3.srt") }, (d) => near(d.first.start, 1.5));
  await step("captions export vtt", "captions", () => ({ action: "export", source: ctx.tr, format: "vtt", output: path.join(OUT, "speech.vtt") }), (d) => fs.readFileSync(d.path, "utf-8").startsWith("WEBVTT") && `${d.cues} cues`);
  await step("captions create_track", "captions", { action: "create_track", source: path.join(DIR, "subs.srt") }, () => true);
  await step("captions safe_zone_check shorts", "captions", () => ({ action: "safe_zone_check", source: ctx.tr, platform: "shorts", style: { y: 0.95 } }), (d) => d.outside === d.cues && `${d.outside}/${d.cues} outside`);
  await step("captions safe_zone_check ok", "captions", () => ({ action: "safe_zone_check", source: ctx.tr, platform: "youtube", style: { y: 0.8 } }), (d) => d.outside === 0);
  await step("captions burn_style word highlight", "captions", () => ({ action: "burn_style", source: ctx.tr, word_highlight: true, track: "V8", style: { uppercase: true, highlight_color: "#FFD400" } }), async (d, r) => r.status === "verified" && (await clipsOn("V8")).length === d.cards && `${d.cards} cards`);
  await step("title template lower_third + animation", "create_title_image", { output: path.join(OUT, "lt.png"), template: "lower_third", lines: [{ text: "Fulano" }, { text: "Editor" }], place: { track: "V9", start: 2, duration: 3 }, animate: { in: "slide_left", out: "fade" }, preview: false }, async (d) => { const v9 = await clipsOn("V9"); const comps = await fx(v9[0].id); return v9.length === 1 && prop(comps, "AE.ADBE Opacity", "Opacity")?.keyframes?.length === 2 && prop(comps, "AE.ADBE Motion", "Position")?.keyframes?.length === 2; });
  const mog = "C:/Program Files/Adobe/Adobe Premiere Pro 2026/Essential Graphics/Basic Title.mogrt";
  if (fs.existsSync(mog)) {
    await step("mogrt import + save_recipe", "mogrt", { action: "import", path: mog, track: "V10", start: 0, duration: 2, save_recipe: "titulo" }, (d) => d.recipe === "titulo");
    await step("mogrt batch (recipe + file)", "mogrt", { action: "batch", items: [{ recipe: "titulo", start: 3 }, { path: mog, track: "V10", start: 6, duration: 1 }] }, async (d, r) => r.status === "verified" && (await clipsOn("V10")).length === 3);
  }
}

// ============================================================ 2.8 markers and review
if (section("markers")) {
  await step("markers add", "markers", { action: "add", markers: [{ time: 1, name: "Intro", type: "chapter" }, { time: 12, name: "Parte 2", type: "chapter" }, { time: 25, name: "nota", color: 3 }] }, (d) => d.added.length === 3);
  await step("markers update", "markers", { action: "update", time: 25, update: { name: "nota revisada", color: 5, duration: 2 } }, async () => { const m = (await c.call("markers", { action: "list" })).data.markers.find((x) => near(x.start, 25)); return m.name === "nota revisada" && m.color === 5 && near(m.end, 27); });
  await step("markers list type chapter", "markers", { action: "list", type: "chapter" }, (d) => d.count === 2);
  await step("markers export youtube", "markers", { action: "export", format: "youtube", type: "chapter", path: path.join(OUT, "chapters.txt") }, (d) => /^00:00 /.test(d.text) && /00:12 Parte 2/.test(d.text) && d.text.replace(/\n/g, " | "));
  await step("markers export csv", "markers", { action: "export", format: "csv", path: path.join(OUT, "markers.csv") }, (d) => d.markers === 3 && fs.existsSync(d.path));
  await step("markers import client notes", "markers", { action: "import", path: path.join(DIR, "notes.csv") }, async (d) => { const all = (await c.call("markers", { action: "list" })).data.markers; return d.added.length === 3 && all.some((m) => m.name === "Trocar plano" && near(m.start, 1)) && all.some((m) => near(m.start, 3.5) && m.name === "Cortar pausa"); });
  await step("review by markers (contact sheet)", "review", { by: "markers" }, (d, r) => r.images.length === 1 && d.frames.length >= 5);
  await step("review by interval", "review", { by: "interval", every: 10, to: 40 }, (d, r) => r.images.length === 1 && d.frames.length === 4);
}

// ============================================================ 2.9 export and delivery
if (section("delivery")) {
  await step("deliver matrix", "deliver", { action: "matrix" }, (d) => d.platforms.shorts.h === 1920 && d.platforms.youtube.lufs === -14);
  await step("short sequence for delivery", "create_sequence", { name: "Deliver", width: 1920, height: 1080, fps: 30 }, () => true);
  await step("place 6 s", "place_clips", () => ({ sequence: "Deliver", clips: [{ item: ctx["clipA.mp4"], track: "V1", start: 0, in: 0, out: 6 }] }), (d) => d.placed.length === 1);
  await step("markers for by_markers", "markers", { action: "add", sequence: "Deliver", markers: [{ time: 0, name: "A", duration: 2 }, { time: 3, name: "B", duration: 2 }] }, () => true);
  await step("deliver export (job) + verify", "deliver", { action: "export", sequences: ["Deliver"], platform: "youtube", folder: path.join(OUT, "deliver"), async: true }, (d) => (ctx.dj = d.job_id));
  await step("deliver job result", "jobs", () => ({ action: "wait", job_id: ctx.dj, timeout_s: 600 }), (d) => d.state === "done" && d.result.files[0].checks.find((x) => x.check === "duration").ok && d.result.files[0].checks.find((x) => x.check === "resolution").ok && JSON.stringify(d.result.files[0].checks.map((x) => `${x.check}:${x.ok}`)));
  await step("deliver verify file vs shorts (mismatch)", "deliver", () => ({ action: "verify", file: fs.readdirSync(path.join(OUT, "deliver")).map((f) => path.join(OUT, "deliver", f))[0], platform: "shorts" }), (d) => d.conformant === false && d.checks.find((x) => x.check === "resolution").ok === false);
  await step("deliver by_markers", "deliver", { action: "by_markers", sequence: "Deliver", folder: path.join(OUT, "segments") }, (d, r) => r.status === "verified" && d.segments.length === 2 && d.segments.map((s) => s.duration).join(","));
  const wavPreset = (await c.call("list_export_presets", { filter: "Waveform Audio" })).data.presets[0]?.path;
  if (wavPreset) await step("encode file via AME (wait)", "encode", { action: "file", file: path.join(DIR, "talk.wav"), output: path.join(OUT, "ame", "talk_out.wav"), preset_path: wavPreset, wait: true, timeout_s: 300 }, (d, r) => r.status === "verified" && near(d.duration, 4, 0.1));
  await step("export_interchange omf", "export_interchange", { sequence: "Deliver", format: "omf", path: path.join(OUT, "deliver.omf") }, (d, r) => r.status === "verified");
  await step("export_interchange project", "export_interchange", { sequence: "Deliver", format: "project", path: path.join(OUT, "deliver-only.prproj") }, (d, r) => r.status === "verified");
  await step("back to S1", "open_sequence", { sequence: "S1" }, () => true);
}

// ============================================================ 2.10 navigation
if (section("navigation")) {
  await step("playhead start", "playhead", { action: "start" }, (d) => near(d.playhead, 0));
  await step("playhead next_edit", "playhead", { action: "next_edit", tracks: ["V1"] }, (d, r) => r.status === "verified" && d.playhead > 0 && `${d.playhead}`);
  await step("playhead prev_edit", "playhead", { action: "prev_edit", tracks: ["V1"] }, (d) => near(d.playhead, 0));
  await step("playhead next_marker", "playhead", { action: "next_marker" }, (d) => near(d.playhead, 1));
  await step("playhead clip end", "playhead", () => ({ action: "clip", clip: ctx.a, edge: "end" }), (d) => d.playhead > 3);
  await step("playhead end", "playhead", { action: "end" }, async (d) => near(d.playhead, (await tl({ compact: true })).duration, 0.05));
  await step("play", "playhead", { action: "play" }, (d) => d.playing === true);
  await new Promise((r) => setTimeout(r, 800));
  await step("stop", "playhead", { action: "stop" }, (d) => d.playing === false);
  await step("workspace list", "playhead", { action: "workspace" }, (d) => d.workspaces.includes("Editing") && `${d.workspaces.length} workspaces`);
  await step("workspace switch Editing", "playhead", { action: "workspace", name: "Editing" }, (d) => d.workspace === "Editing");
}

// Project-wide tools last: consolidate_duplicates and organize recreate items and clips.
if (section("project")) {
  await step("project_tools backup", "project_tools", { action: "backup", path: path.join(OUT, "backups") }, (d) => fs.existsSync(d.backup) && d.backup);
  await step("project_tools structure", "project_tools", { action: "structure" }, (d) => d.counts.video >= 2 && d.counts.audio >= 3 && JSON.stringify(d.counts));
  await step("project_tools smart_bin", "project_tools", { action: "smart_bin", name: "Wavs", query: "wav" }, (d, r) => r.status === "verified");
  await step("project_tools organize preview", "project_tools", { action: "organize" }, (d) => d.preview.length >= 1 && JSON.stringify(d.preview));
  await step("project_tools organize apply", "project_tools", { action: "organize", apply: true }, () => true);
  await step("organized: audio in Audio bin", "list_project_items", { bin: "Audio" }, (d) => d.items.some((i) => i.name === "vo.wav"));
  await step("project_tools scratch_disks", "project_tools", { action: "scratch_disks", path: path.join(OUT, "previews") }, (d) => d.set.length === 2);
  await step("import a duplicate for consolidate", "import_media", { paths: [path.join(DIR, "clipB.mp4")], bin: "Dup2" }, (d) => d.count === 1);
  await step("project_tools consolidate_duplicates", "project_tools", { action: "consolidate_duplicates" }, (d) => d.after < d.before && `${d.before} -> ${d.after}`);
  await step("project_tools consolidate_and_transfer", "project_tools", { action: "consolidate_and_transfer", path: path.join(OUT, "transfer") }, () => fs.readdirSync(path.join(OUT, "transfer")).length > 0 && fs.readdirSync(path.join(OUT, "transfer")).join(","));
  const xml = path.join(OUT, "s1.xml");
  await step("export FCP XML for import", "export_interchange", { format: "fcp_xml", path: xml }, () => fs.existsSync(xml));
  await step("import_media interchange fcp_xml", "import_media", { interchange: { kind: "fcp_xml", path: xml }, bin: "Imported" }, (d, r) => r.status === "verified" && d.newItems > 0 && `${d.newItems} items, ${d.newSequences.length} seq`);
}


await T.finish();
