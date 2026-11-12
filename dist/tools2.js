import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { BridgeError } from "./bridge.js";
import * as media from "./media.js";
import * as an from "./analysis.js";
import * as cap from "./captions.js";
/** Phase 2 tools (capability parity). ctx carries the registration helpers from tools.ts. */
export function registerPhase2(ctx) {
    const { tool, call, ANN, seqArg, clipSelector, track, scratch, ensureOutputDir, bridge, jobs, packageRoot } = ctx;
    const unsupported = (what, alt) => {
        throw new BridgeError("UNSUPPORTED_IN_PREMIERE", what, alt);
    };
    const sources = async (sequence, clips) => (await call("clip_media", { sequence, clips }));
    const exportFrame = async (sequence, t) => {
        const pngPreset = media.findExportPresets("PNG Sequence \\(Match Source\\)").find((p) => !/Alpha/i.test(p.name) && /Premiere/i.test(p.path))?.path || media.findExportPresets("PNG").find((p) => !/Alpha/i.test(p.name))?.path;
        const r = await call("export_frame", { sequence, times: [t], folder: scratch, png_preset: pngPreset }, 60000);
        const f = r.frames?.[0]?.path;
        if (!f)
            throw new BridgeError("FRAME_EXPORT_FAILED", `Could not render the frame at ${t}s.`, r.hint);
        return f;
    };
    // ======================================================== 2.1 inspection
    tool("inspect", "Inspect", "Read project/timeline facts. action: project_overview, sequence, clip, timeline_summary (coverage, gaps, effects, disabled/offline/speed clips), gaps, health (+ black frames, flashes, audio clipping via FFmpeg), used_media, unused_media, duplicates, offline, state (playhead, selection, targeted tracks). E.g. {action:'health'}", {
        action: z.enum(["project_overview", "sequence", "clip", "timeline_summary", "gaps", "health", "used_media", "unused_media", "duplicates", "offline", "state"]),
        sequence: seqArg,
        clips: clipSelector.optional(),
        detail: z.boolean().optional(),
        min_gap: z.number().optional().describe("gaps: shortest gap reported (s), default 1 frame"),
        limit: z.number().int().optional(),
    }, ANN.read, async (a) => {
        switch (a.action) {
            case "project_overview": {
                const [st, used, unused, off] = await Promise.all([call("get_state", { compact: false }), call("inspect_media", { mode: "used", limit: 0 }), call("inspect_media", { mode: "unused", limit: 0 }), call("inspect_media", { mode: "offline", limit: 50 })]);
                return { ...st, media: { used: used.count, unused: unused.count, offline: off.count, offlineItems: off.items } };
            }
            case "sequence":
                return call("get_timeline", { sequence: a.sequence, include_effects: true, include_media: !!a.detail, skip_empty: true });
            case "clip":
                return call("inspect_clip", { sequence: a.sequence, clips: a.clips ?? { selected: true }, detail: a.detail, limit: a.limit });
            case "timeline_summary":
                return call("timeline_summary", { sequence: a.sequence, min_gap: a.min_gap, detail: a.detail });
            case "gaps":
                return call("timeline_summary", { sequence: a.sequence, mode: "gaps", min_gap: a.min_gap, limit: a.limit });
            case "health": {
                const sum = await call("timeline_summary", { sequence: a.sequence, min_gap: a.min_gap ?? 0.04 });
                const src = await sources(a.sequence, a.clips ?? {});
                const issues = [];
                const max = a.limit || 40;
                for (const c of src.clips.slice(0, max)) {
                    if (!c.media || !fs.existsSync(c.media) || c.disabled)
                        continue;
                    const dur = (c.end - c.start) * (c.speed || 1);
                    if (c.video && !/\.(png|jpe?g|psd|tiff?|gif|webp|bmp)$/i.test(c.media)) {
                        for (const b of await an.blackFrames(c.media, c.in, dur))
                            issues.push({ type: "black_frames", clip: c.id, track: c.track, at: an.r3(c.start + (b.start - c.in) / (c.speed || 1)), duration: an.r3(b.end - b.start) });
                        for (const t of await an.flashes(c.media, c.in, dur))
                            issues.push({ type: "flash", clip: c.id, track: c.track, at: an.r3(c.start + (t - c.in) / (c.speed || 1)) });
                    }
                    if (!c.video) {
                        const s = await an.audioStats(c.media, c.in, dur);
                        const gain = c.volumeDb ?? 0;
                        if (s.peakDb !== null && s.peakDb + gain >= -0.1)
                            issues.push({ type: "audio_clipping", clip: c.id, track: c.track, at: c.start, peakDb: an.r3(s.peakDb + gain) });
                    }
                }
                for (const d of sum.disabled || [])
                    issues.push({ type: "disabled_clip", clip: d.id, track: d.track, at: d.start });
                for (const d of sum.offline || [])
                    issues.push({ type: "offline_clip", clip: d.id, track: d.track, at: d.start });
                return { duration: sum.duration, tracks: sum.tracks, gaps: sum.gaps, issues, checkedClips: Math.min(max, src.clips.length), totalClips: src.clips.length };
            }
            case "used_media":
            case "unused_media":
            case "offline":
                return call("inspect_media", { mode: a.action === "used_media" ? "used" : a.action === "unused_media" ? "unused" : "offline", detail: a.detail, limit: a.limit });
            case "duplicates":
                return call("inspect_media", { mode: "duplicates", limit: a.limit });
            case "state":
                return call("inspect_state", {});
        }
    });
    tool("search_items", "Search project items", "Find project items by name (substring), regex, extension, type, color label, offline, used/unused in sequences, or bin.", {
        name: z.string().optional(),
        regex: z.string().optional(),
        extensions: z.array(z.string()).optional().describe('e.g. ["mp4","wav"]'),
        types: z.array(z.enum(["bin", "clip", "file", "sequence"])).optional(),
        label: z.number().int().optional(),
        offline: z.boolean().optional(),
        used: z.boolean().optional(),
        bin: z.string().optional(),
        detail: z.boolean().optional(),
        limit: z.number().int().optional(),
    }, ANN.read, (a) => call("search_items", a));
    // ======================================================== 2.11 metadata
    tool("metadata", "Metadata", "Read or write clip metadata of project items: Log Note, Scene, Shot, Take, Description, Good (XMP, what the Metadata panel shows) and custom project-panel fields; color labels in bulk; add_field creates a custom project metadata field. get hides GPS, serial numbers and author fields unless include_sensitive: true.", {
        action: z.enum(["get", "set", "label", "add_field"]),
        items: z.array(z.string()).optional(),
        values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('set: {"Log Note": "...", "Scene": "1", "Good": true, "MyField": "x"}'),
        fields: z.array(z.string()).optional().describe("get: custom project fields to read"),
        label: z.number().int().min(0).max(15).optional(),
        field: z.string().optional(),
        field_label: z.string().optional(),
        type: z.number().int().optional().describe("add_field: 0 integer, 1 real, 2 text, 3 boolean"),
        detail: z.boolean().optional().describe("get: every XMP field"),
        include_sensitive: z.boolean().optional(),
    }, ANN.write, (a) => call("metadata", a));
    // ======================================================== 2.2 media and project
    const watchers = new Map();
    tool("media", "Media management", "Media of project items. relink (path, or search: a folder searched for files with the same name, and the same duration when ffprobe can read both), set_offline, proxies (create_proxies through Media Encoder with a preset, attach_proxy, detach_proxy, proxy_status, proxies_enable), interpret (fps, par, field, alpha), scale_to_frame, color_space (read or override), input_lut (.cube on the source), watch_folder (import new files from a folder into a bin automatically; stop_watch, list_watches). poster_frame and audio_channel_mapping return UNSUPPORTED_IN_PREMIERE.", {
        action: z.enum(["relink", "set_offline", "create_proxies", "attach_proxy", "detach_proxy", "proxy_status", "proxies_enable", "interpret", "scale_to_frame", "color_space", "input_lut", "watch_folder", "stop_watch", "list_watches", "poster_frame", "audio_channel_mapping"]),
        items: z.array(z.string()).optional(),
        path: z.string().optional().describe("relink/attach_proxy/input_lut: file; watch_folder: folder"),
        paths: z.array(z.string()).optional().describe("one file per item"),
        search: z.string().optional().describe("relink: folder to search (recursive)"),
        offline_only: z.boolean().optional().describe("relink with search and no items: every offline item"),
        preset_path: z.string().optional().describe("create_proxies: .epr (default: a Premiere proxy preset)"),
        proxy_folder: z.string().optional(),
        enabled: z.boolean().optional(),
        fps: z.number().optional(),
        par: z.number().optional(),
        field: z.enum(["default", "progressive", "upper", "lower"]).optional(),
        alpha: z.enum(["none", "straight", "premultiplied", "ignore"]).optional(),
        color_space: z.string().optional(),
        bin: z.string().optional(),
    }, ANN.write, async (a) => {
        if (a.action === "poster_frame")
            unsupported("Premiere's scripting API cannot set a clip's poster frame.", "Set it in the Project panel (hover scrub + Shift+P).");
        if (a.action === "audio_channel_mapping")
            unsupported("Premiere 26.x exposes no scripting call to change a clip's audio channel mapping (Modify > Audio Channels).", "Change it in Premiere, or place media:'audio' clips on the tracks you need.");
        if (a.action === "list_watches")
            return { watches: [...watchers.keys()] };
        if (a.action === "stop_watch") {
            const k = path.resolve(a.path || "");
            watchers.get(k)?.close();
            return { stopped: watchers.delete(k) };
        }
        if (a.action === "watch_folder") {
            const dir = path.resolve(a.path || "");
            if (!fs.existsSync(dir))
                throw new BridgeError("FILE_NOT_FOUND", `Folder not found: ${dir}`);
            if (watchers.has(dir))
                return { watching: dir, already: true };
            const seen = new Set(fs.readdirSync(dir));
            const pending = new Map();
            const w = fs.watch(dir, (_e, name) => {
                if (!name || seen.has(String(name)) || !media.MEDIA_EXT.test(String(name)))
                    return;
                const f = path.join(dir, String(name));
                clearTimeout(pending.get(f));
                // Import once the file stops growing.
                pending.set(f, setTimeout(async () => {
                    if (!fs.existsSync(f))
                        return;
                    seen.add(String(name));
                    await call("import_files", { paths: [f], bin: a.bin || "Watch" }).catch(() => seen.delete(String(name)));
                }, 3000));
            });
            watchers.set(dir, w);
            return { watching: dir, bin: a.bin || "Watch", existingIgnored: seen.size };
        }
        if (a.action === "relink" && a.search) {
            const root = path.resolve(a.search);
            const files = media.listMediaFiles(root, true).map((f) => f.file);
            const recs = await call("media_items", a.items ? { items: a.items } : { offline_only: a.offline_only !== false });
            const out = [];
            for (const it of recs.items) {
                const base = path.basename(it.media || it.name).toLowerCase();
                const cands = files.filter((f) => path.basename(f).toLowerCase() === base);
                let pick = cands[0];
                if (cands.length > 1 && it.duration) {
                    for (const f of cands) {
                        const p = await media.probe(f).catch(() => null);
                        if (p && Math.abs(Number(p.duration) - it.duration) < 0.1)
                            pick = f;
                    }
                }
                if (!pick) {
                    out.push({ id: it.id, name: it.name, relinked: false, reason: "no file with that name" });
                    continue;
                }
                const r = await call("media_action", { action: "relink", items: [it.id], path: pick }).catch((e) => ({ error: e.message }));
                out.push({ id: it.id, name: it.name, relinked: !!r.verified, path: pick, error: r.error });
            }
            return { results: out, verified: out.every((o) => o.relinked) };
        }
        if (a.action === "create_proxies") {
            const items = a.items || [];
            if (!items.length)
                throw new BridgeError("BAD_ARGS", "Pass items.");
            const preset = a.preset_path || media.findExportPresets("Proxy|ProRes Proxy|H\\.264 Low").find((p) => /proxy/i.test(p.name) || /proxy/i.test(p.folder || ""))?.path || media.findExportPresets("H\\.264").find((p) => /low|1280|720/i.test(p.name))?.path;
            if (!preset)
                throw new BridgeError("PRESET_NOT_FOUND", "No proxy export preset found.", "Pass preset_path (.epr).");
            const recs = await call("media_items", { items });
            const folder = path.resolve(a.proxy_folder || path.join(path.dirname(recs.items[0].media || os.tmpdir()), "Proxies"));
            ensureOutputDir(folder);
            const out = [];
            for (const it of recs.items) {
                const dest = path.join(folder, path.basename(it.media || it.name, path.extname(it.media || it.name)) + "_Proxy" + (/prores|quicktime|mov/i.test(preset) ? ".mov" : ".mp4"));
                const started = Date.now() - 2000;
                await call("encode", { action: "item", item: it.id, output: dest, preset_path: preset });
                // AME may change the extension: look for the newest file with that stem.
                const stem = path.basename(dest, path.extname(dest));
                let found = null;
                const end = Date.now() + 15 * 60_000;
                while (!found && Date.now() < end) {
                    await new Promise((r) => setTimeout(r, 2000));
                    for (const f of fs.readdirSync(folder))
                        if (f.startsWith(stem) && fs.statSync(path.join(folder, f)).mtimeMs > started)
                            found = path.join(folder, f);
                    if (found && !(await media.waitForValidMedia(found, 30_000)).valid)
                        found = null;
                }
                if (!found) {
                    out.push({ id: it.id, proxy: null, error: "Media Encoder did not produce the proxy in time." });
                    continue;
                }
                let att = await call("media_action", { action: "attach_proxy", items: [it.id], path: found });
                if (!att.verified && it.media) {
                    // Premiere refuses a proxy whose audio layout differs from the source (AME adds
                    // stereo audio to video-only media): match it with a stream copy and retry.
                    const streams = async (f) => (await media.probe(f)).streams?.map((x) => x.type) || [];
                    const srcAudio = (await streams(it.media)).includes("audio");
                    if (!srcAudio && (await streams(found)).includes("audio")) {
                        const fixed = found.replace(/(.[^.]+)$/, "_v$1");
                        await an.remux(found, fixed, ["-map", "0:v", "-c", "copy"]);
                        found = fixed;
                        att = await call("media_action", { action: "attach_proxy", items: [it.id], path: found });
                    }
                }
                out.push({ id: it.id, proxy: found, attached: att.verified });
            }
            return { preset, results: out, verified: out.every((o) => o.attached) };
        }
        return call("media_action", { ...a, path: a.path ? path.resolve(a.path) : undefined, paths: a.paths?.map((p) => path.resolve(p)) });
    }, { async: true });
    tool("project_tools", "Project tools", "backup (copy the .prproj to a dated file; max_mb limit), consolidate_and_transfer (Project Manager: copy used media + project to a folder), consolidate_duplicates, scratch_disks (preview/autosave folders), smart_bin (search query), structure (bins and media counts by kind), organize (sort items into bins by kind: preview first, nothing is deleted).", {
        action: z.enum(["backup", "consolidate_and_transfer", "consolidate_duplicates", "scratch_disks", "smart_bin", "structure", "organize"]),
        path: z.string().optional(),
        max_mb: z.number().optional(),
        exclude_unused: z.boolean().optional(),
        handle_frames: z.number().int().optional(),
        types: z.array(z.enum(["capture_video", "capture_audio", "previews_video", "previews_audio", "autosave", "cc_libraries", "capsule_media"])).optional(),
        name: z.string().optional(),
        query: z.string().optional(),
        bin: z.string().optional(),
        apply: z.boolean().optional().describe("organize: move the items (default: preview only)"),
        rules: z.record(z.string(), z.string()).optional().describe('organize: kind -> bin, default {"video":"Footage","audio":"Audio","image":"Images","graphic":"Graphics","sequence":"Sequences"}'),
    }, ANN.write, async (a) => {
        if (a.action === "backup") {
            const st = await call("get_state", { compact: true });
            await call("save_project", {});
            const src = st.project.path;
            const size = fs.statSync(src).size / 1e6;
            if (a.max_mb && size > a.max_mb)
                throw new BridgeError("TOO_LARGE", `The project is ${size.toFixed(1)} MB (> max_mb ${a.max_mb}).`);
            const dir = path.resolve(a.path || path.join(path.dirname(src), "Backups"));
            ensureOutputDir(dir);
            const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
            const dest = path.join(dir, `${path.basename(src, ".prproj")}_${stamp}.prproj`);
            fs.copyFileSync(src, dest);
            return { backup: dest, mb: an.r3(size), verified: fs.statSync(dest).size === fs.statSync(src).size };
        }
        if (a.action === "organize") {
            const st = await call("project_tools", { action: "structure", with_items: true });
            const rules = a.rules || { video: "Footage", audio: "Audio", image: "Images", graphic: "Graphics", sequence: "Sequences" };
            const moves = {};
            for (const it of st.bins.filter((b) => typeof b === "object")) {
                const dest = rules[it.kind];
                if (!dest || it.bin === dest || it.bin.startsWith("_MCP Plus"))
                    continue;
                (moves[dest] ||= []).push(it.id);
            }
            const plan = Object.entries(moves).map(([bin, ids]) => ({ bin, items: ids.length }));
            if (!a.apply)
                return { preview: plan, hint: "Repeat with apply: true to move the items (nothing is deleted)." };
            const done = [];
            for (const [bin, ids] of Object.entries(moves))
                done.push({ bin, ...(await call("move_items", { bin, items: ids, create: true })) });
            return { moved: done, verified: true };
        }
        return call("project_tools", { ...a, path: a.path ? path.resolve(a.path) : undefined }, 1_800_000);
    }, {
        confirm: (a) => (a.action === "consolidate_and_transfer" || a.action === "consolidate_duplicates" ? { action: a.action, note: a.action === "consolidate_duplicates" ? "Duplicate items are merged into one; timeline clips are repointed." : `Copies the project and its used media to ${a.path}.` } : null),
    });
    // ======================================================== 2.4 editing additions
    tool("ripple_delete_ranges", "Ripple delete ranges", "Remove many time ranges with ripple in one call (e.g. every silence), on all tracks (keeps sync) or on given tracks. Ranges are snapped to frames and merged; the sequence shortens by their total.", { sequence: seqArg, ranges: z.array(z.object({ start: z.number(), end: z.number() })).min(1), tracks: z.array(z.string()).optional() }, ANN.destructive, (a) => call("ripple_delete_ranges", a, 600000), { checkpoint: true, confirm: (a) => (a.ranges.length > 20 ? { ranges: a.ranges.length, seconds: an.r3(a.ranges.reduce((n, r) => n + (r.end - r.start), 0)) } : null) });
    tool("source", "Source monitor", "open an item in the Source Monitor (with in/out), state, close, insert / overwrite the source into the targeted tracks (or video_track/audio_track) at time or the playhead, match_frame (open the source of the clip under the playhead and report its media time).", {
        action: z.enum(["open", "state", "close", "insert", "overwrite", "match_frame"]),
        sequence: seqArg,
        item: z.string().optional(),
        in: z.number().optional(),
        out: z.number().optional(),
        time: z.number().optional(),
        video_track: track.optional(),
        audio_track: track.optional(),
    }, ANN.write, (a) => call("source", a));
    // ======================================================== 2.5 color, effects, keyframes
    tool("color", "Color", "Lumetri color on many clips. basic: set exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, vibrance, faded_film, sharpen, vignette_* (adds Lumetri if missing; values re-read). read: current values. match_shot: match exposure and white balance of clips to a reference clip from rendered frames. auto_balance: neutralize color cast and set exposure from a rendered frame. apply_lut: input LUT (.cube) on the clips' source media. A Creative Look file on a clip returns UNSUPPORTED_IN_PREMIERE.", {
        action: z.enum(["basic", "read", "match_shot", "auto_balance", "apply_lut", "look"]),
        sequence: seqArg,
        clips: clipSelector.optional(),
        reference: z.string().optional().describe("match_shot: reference clip id"),
        values: z.record(z.string(), z.number()).optional(),
        path: z.string().optional().describe("apply_lut: .cube file"),
        target_luma: z.number().optional().describe("auto_balance: mean luma % (default 45)"),
    }, ANN.write, async (a) => {
        if (a.action === "basic")
            return call("color_basic", a, 120000);
        if (a.action === "read")
            return call("color_read", a);
        if (a.action === "look")
            unsupported("A Creative Look file cannot be loaded into Lumetri by script (the Look slot is a binary asset).", "Use apply_lut (input LUT on the source media) or an Effect Preset saved with the look (apply_effect_preset).");
        if (a.action === "apply_lut") {
            const src = await sources(a.sequence, a.clips);
            const items = [...new Set(src.clips.map((c) => c.item))];
            return call("media_action", { action: "input_lut", items, path: path.resolve(a.path || "") });
        }
        const src = await sources(a.sequence, a.clips);
        const vids = src.clips.filter((c) => c.video);
        if (!vids.length)
            throw new BridgeError("NO_CLIPS_MATCHED", "No video clips selected.");
        const statsAt = async (c) => an.frameStats(await exportFrame(a.sequence, an.r3((c.start + c.end) / 2)));
        let ref = null;
        if (a.action === "match_shot") {
            if (!a.reference)
                throw new BridgeError("BAD_ARGS", "reference (clip id) is required.");
            const rs = await sources(a.sequence, a.reference);
            ref = await statsAt(rs.clips[0]);
        }
        const out = [];
        for (const c of vids) {
            if (ref && c.id === a.reference)
                continue;
            const st = await statsAt(c);
            const cur = (await call("color_read", { sequence: a.sequence, clips: c.id })).clips[0];
            const v = cur.values || {};
            const targetLuma = ref ? ref.luma.mean : a.target_luma ?? 45;
            const targetBalance = ref ? ref.rgb.b - ref.rgb.r : 0;
            // Exposure: stops from the luma ratio (gamma-ish); temperature from the red/blue balance.
            const stops = Math.max(-2, Math.min(2, Math.log2(Math.max(1, targetLuma) / Math.max(1, st.luma.mean)) * 0.8));
            const balance = st.rgb.b - st.rgb.r;
            const temp = Math.max(-60, Math.min(60, (balance - targetBalance) * 2));
            const tintG = ref ? ref.rgb.g - (ref.rgb.r + ref.rgb.b) / 2 : 0;
            const tint = Math.max(-60, Math.min(60, (st.rgb.g - (st.rgb.r + st.rgb.b) / 2 - tintG) * -2));
            const values = { exposure: an.r3((v.exposure || 0) + stops), temperature: an.r3((v.temperature || 0) + temp), tint: an.r3((v.tint || 0) + tint) };
            await call("color_basic", { sequence: a.sequence, clips: c.id, values });
            const after = await statsAt(c);
            out.push({ id: c.id, before: { luma: st.luma.mean, rgb: st.rgb }, after: { luma: after.luma.mean, rgb: after.rgb }, set: values, target: { luma: an.r3(targetLuma) } });
        }
        const improved = out.every((o) => Math.abs(o.after.luma - o.target.luma) <= Math.abs(o.before.luma - o.target.luma) + 1);
        return { clips: out, verified: improved, note: "Values come from rendered frames; check with scopes or export_frames." };
    }, { async: true });
    tool("stabilize", "Stabilize", "Apply Warp Stabilizer to clips and wait for Premiere's analysis (use async: true for long clips). status reports whether analysis is done.", { action: z.enum(["apply", "status"]).optional(), sequence: seqArg, clips: clipSelector.optional(), wait: z.boolean().optional().describe("Default true"), timeout_s: z.number().optional() }, ANN.write, async (a, jctx) => {
        if (a.action === "status")
            return call("analysis_status", a);
        const r = await call("stabilize", a, 120000);
        if (a.wait === false)
            return r;
        const end = Date.now() + (a.timeout_s || 900) * 1000;
        const t0 = Date.now();
        while (Date.now() < end) {
            const st = await call("analysis_status", { sequence: a.sequence });
            if (st.done && !st.progressItems)
                return { ...r, analysisDone: true, seconds: Math.round((Date.now() - t0) / 1000), verified: r.clips.every((c) => c.added) };
            jctx?.progress?.(Math.min(0.95, (Date.now() - t0) / ((a.timeout_s || 900) * 1000)), "analyzing");
            await new Promise((res) => setTimeout(res, 2000));
        }
        throw new BridgeError("ANALYSIS_TIMEOUT", "Warp Stabilizer analysis did not finish in time.", "Check Premiere; status reports progress.");
    }, { async: true });
    tool("adjustment_layer", "Adjustment layer", "Place an adjustment layer with a duration and effects (or a preset). Premiere cannot create one by script: the first Adjustment Layer found in the project is reused (UNSUPPORTED_IN_PREMIERE when there is none).", { sequence: seqArg, item: z.string().optional(), track: track.optional(), start: z.number().optional(), duration: z.number().optional(), effects: z.array(z.union([z.string(), z.object({ name: z.string(), params: z.record(z.string(), z.any()).optional() })])).optional() }, ANN.write, (a) => call("adjustment_layer", a));
    tool("keyframe_tools", "Keyframe tools", "Work on existing keyframes of a property on many clips (times are seconds from each clip's start). list, value_at (time), interpolation (linear, hold, bezier, ease) for keys in from..to, move keys in range by delta, scale key times by factor around pivot.", {
        action: z.enum(["list", "value_at", "interpolation", "move", "scale"]),
        sequence: seqArg,
        clips: clipSelector,
        effect: z.string().optional(),
        property: z.string(),
        time: z.number().optional(),
        interp: z.enum(["linear", "hold", "bezier", "ease"]).optional(),
        from: z.number().optional(),
        to: z.number().optional(),
        delta: z.number().optional(),
        factor: z.number().optional(),
        pivot: z.number().optional(),
    }, ANN.write, (a) => call("keyframe_tools", a));
    tool("scopes", "Scopes", "Measure a rendered frame of the sequence (luma mean/min/max, RGB means, crushed blacks / clipped whites %, color cast) to check exposure and color without looking.", { sequence: seqArg, times: z.array(z.number()).min(1).max(20) }, ANN.read, async (a) => {
        const out = [];
        for (const t of a.times)
            out.push({ time: t, ...(await an.frameStats(await exportFrame(a.sequence, t))) });
        return { frames: out };
    });
    tool("mask_fit", "Fit a region", "Frame a rectangle of the clip (face, object) to fill the sequence frame or a target box: computes Motion scale and position and applies them (static, or keyframed between from and to rects). Rects are in pixels of the clip as it shows at 100% scale centered.", {
        sequence: seqArg,
        clips: clipSelector,
        rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
        to_rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("Animate from rect (clip start) to to_rect (clip end)"),
        fit: z.enum(["fill", "fit"]).optional(),
        padding: z.number().optional().describe("Fraction around the rect, default 0.1"),
    }, ANN.write, async (a) => {
        const st = await call("get_sequence_settings", { sequence: a.sequence });
        const W = st.width;
        const H = st.height;
        const solve = (r) => {
            const pad = 1 + (a.padding ?? 0.1) * 2;
            const sx = W / (r.w * pad);
            const sy = H / (r.h * pad);
            const s = a.fit === "fit" ? Math.min(sx, sy) : Math.max(Math.min(sx, sy), Math.min(Math.max(sx, sy), 20));
            const scale = Math.min(sx, sy) * 100;
            const cx = r.x + r.w / 2;
            const cy = r.y + r.h / 2;
            // Clip center sits at the frame center at 100%: move so the rect center lands there.
            const pos = [W / 2 + (W / 2 - cx) * (scale / 100), H / 2 + (H / 2 - cy) * (scale / 100)];
            return { scale: an.r3(a.fit === "fill" ? s * 100 : scale), position: pos.map(an.r3) };
        };
        const p0 = solve(a.rect);
        if (!a.to_rect)
            return { ...(await call("set_transform", { sequence: a.sequence, clips: a.clips, scale: p0.scale, position: p0.position })), computed: p0 };
        const p1 = solve(a.to_rect);
        const r = await call("add_keyframes", {
            sequence: a.sequence,
            clips: a.clips,
            animations: [
                { property: "Scale", replace: true, keys: [{ t: 0, v: p0.scale }, { t: "end", v: p1.scale, interp: "ease" }] },
                { property: "Position", replace: true, unit: "px", keys: [{ t: 0, v: p0.position }, { t: "end", v: p1.position, interp: "ease" }] },
            ],
        });
        return { ...r, computed: { from: p0, to: p1 }, verified: !r.errors?.length };
    });
    // ======================================================== 2.6 audio
    tool("audio", "Audio", "Audio on many clips. pan (-100..100, Balance effect), gain (dB, Amplify effect; clip gain is read-only for scripts), mute/unmute clips, solo_track (mute the other audio tracks), normalize (each clip's volume set so its media range hits target LUFS, default -16 voice / -23 music), loudness (measure clips), duck (lower music clips under voice clips with volume keyframes from the voice envelope: duck_db, attack, release, padding), detect_beats / detect_transients (of a clip's media), effect (DeNoise, DeEsser, Dynamics, Parametric Equalizer, Hard Limiter, Studio Reverb... with params). channel_mapping returns UNSUPPORTED_IN_PREMIERE.", {
        action: z.enum(["pan", "gain", "mute", "unmute", "solo_track", "normalize", "loudness", "duck", "detect_beats", "detect_transients", "effect", "channel_mapping"]),
        sequence: seqArg,
        clips: clipSelector.optional(),
        tracks: z.array(z.string()).optional(),
        pan: z.number().min(-100).max(100).optional(),
        db: z.number().optional(),
        target_lufs: z.number().optional(),
        voice: clipSelector.optional().describe("duck: the voice clips (default tracks A1)"),
        music: clipSelector.optional().describe("duck: the music clips to lower"),
        duck_db: z.number().optional().describe("duck: reduction under voice, default -12"),
        attack: z.number().optional().describe("duck: seconds to go down, default 0.25"),
        release: z.number().optional().describe("duck: seconds to come back, default 0.5"),
        padding: z.number().optional().describe("duck: extend voice regions, default 0.2"),
        min_gap: z.number().optional().describe("duck: voice pauses shorter than this stay ducked, default 0.8"),
        effects: z.array(z.union([z.string(), z.object({ name: z.string(), params: z.record(z.string(), z.any()).optional() })])).optional(),
        include_linked: z.boolean().optional(),
    }, ANN.write, async (a, jctx) => {
        if (a.action === "channel_mapping")
            unsupported("Premiere 26.x has no scripting call for a clip's audio channel mapping.", "Use Clip > Modify > Audio Channels in Premiere.");
        if (["pan", "gain", "mute", "unmute", "solo_track"].includes(a.action))
            return call("audio_tools", a);
        if (a.action === "effect")
            return call("apply_effects", { sequence: a.sequence, clips: a.clips, effects: a.effects }, 120000);
        if (a.action === "detect_beats" || a.action === "detect_transients") {
            const src = await sources(a.sequence, a.clips);
            const c = src.clips.find((x) => x.media) || src.clips[0];
            const b = await an.beats(c.media, c.in, c.out - c.in);
            const toSeq = (t) => an.r3(c.start + (t - c.in) / (c.speed || 1));
            if (a.action === "detect_transients")
                return { clip: c.id, transients: b.onsets.map(toSeq), count: b.onsets.length };
            return { clip: c.id, bpm: b.bpm, beats: b.beats.map(toSeq).filter((t) => t >= c.start - 0.001 && t <= c.end + 0.001), count: b.beats.length };
        }
        if (a.action === "loudness" || a.action === "normalize") {
            const src = await sources(a.sequence, a.clips);
            const auds = src.clips.filter((c) => !c.video && c.media);
            if (!auds.length)
                throw new BridgeError("NO_AUDIO", "No audio clips selected.");
            const out = [];
            for (const [i, c] of auds.entries()) {
                jctx?.progress?.(i / auds.length);
                const l = await an.loudnessOf(c.media, c.in, c.out - c.in);
                const gain = c.volumeDb ?? 0;
                const row = { id: c.id, track: c.track, mediaLufs: l.lufs, clipLufs: l.lufs !== null ? an.r3(l.lufs + gain) : null, truePeak: l.truePeak, volumeDb: gain };
                if (a.action === "normalize" && l.lufs !== null && isFinite(l.lufs)) {
                    const target = a.target_lufs ?? -16;
                    const db = an.r3(Math.max(-60, Math.min(15, target - l.lufs)));
                    await call("set_volume", { sequence: a.sequence, clips: c.id, db, include_linked: false });
                    row.setDb = db;
                    row.expectedLufs = target;
                }
                out.push(row);
            }
            return { clips: out, verified: a.action === "normalize" ? out.every((o) => o.setDb !== undefined) : undefined };
        }
        // duck
        const voice = await sources(a.sequence, a.voice ?? { tracks: ["A1"] });
        const music = await sources(a.sequence, a.music ?? { tracks: ["A2"] });
        const vclips = voice.clips.filter((c) => !c.video && c.media);
        const mclips = music.clips.filter((c) => !c.video);
        if (!vclips.length || !mclips.length)
            throw new BridgeError("NO_AUDIO", "Need voice clips and music clips (audio).", "Pass voice and music selectors.");
        // Voice regions in sequence time.
        const regions = [];
        for (const c of vclips) {
            const env = await an.envelope(c.media, 0.02, c.in, c.out - c.in);
            const th = an.autoThreshold(env).threshold;
            for (const r of an.activeRegions(env, th, a.min_gap ?? 0.8, 0.15))
                regions.push({ start: c.start + r.start / (c.speed || 1), end: c.start + r.end / (c.speed || 1) });
        }
        regions.sort((x, y) => x.start - y.start);
        const pad = a.padding ?? 0.2;
        const merged = [];
        for (const r of regions) {
            const s = r.start - pad;
            const e = r.end + pad;
            if (merged.length && s - merged[merged.length - 1].end < (a.min_gap ?? 0.8))
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, e);
            else
                merged.push({ start: s, end: e });
        }
        const atk = a.attack ?? 0.25;
        const rel = a.release ?? 0.5;
        const out = [];
        for (const m of mclips) {
            const base = m.volumeDb ?? 0;
            const low = base + (a.duck_db ?? -12);
            const keys = [{ t: 0, db: base }];
            for (const r of merged) {
                if (r.end <= m.start || r.start >= m.end)
                    continue;
                const s = r.start - m.start;
                const e = r.end - m.start;
                keys.push({ t: Math.max(0, s - atk), db: base }, { t: Math.max(0, s), db: low }, { t: e, db: low }, { t: e + rel, db: base });
            }
            const dur = m.end - m.start;
            const clean = keys.filter((k) => k.t >= 0 && k.t <= dur).sort((x, y) => x.t - y.t);
            await call("set_volume", { sequence: a.sequence, clips: m.id, keys: clean.map((k) => ({ t: an.r3(k.t), db: an.r3(k.db) })), include_linked: false });
            out.push({ id: m.id, keys: clean.length, duckedRegions: merged.filter((r) => r.end > m.start && r.start < m.end).length });
        }
        return { voiceRegions: merged.map((r) => ({ start: an.r3(r.start), end: an.r3(r.end) })), music: out, verified: out.every((o) => o.keys > 1) };
    }, { async: true });
    // ======================================================== 2.7 captions and transcription
    const transcriptDir = path.join(bridge.dir, "transcripts");
    tool("transcribe", "Transcribe", "Local word-level transcription (faster-whisper; no upload). Pass a file, or clips of the sequence (their media ranges, returned in sequence time). Returns segments and words with times and saves the JSON; captions: true also writes an .srt next to it.", {
        file: z.string().optional(),
        sequence: seqArg,
        clips: clipSelector.optional(),
        model: z.enum(["tiny", "base", "small", "medium", "large-v3"]).optional().describe("Default base"),
        language: z.string().optional().describe("e.g. pt, en (default: detect)"),
        captions: z.boolean().optional(),
        max_chars: z.number().int().optional(),
    }, ANN.read, async (a) => {
        ensureOutputDir(transcriptDir);
        const scriptDir = path.join(packageRoot(), "scripts");
        const parts = [];
        if (a.file)
            parts.push({ file: path.resolve(a.file), offset: 0, speed: 1 });
        else {
            const src = await sources(a.sequence, a.clips ?? { kind: "audio" });
            for (const c of src.clips.filter((x) => x.media && !x.video))
                parts.push({ file: c.media, start: c.in, dur: c.out - c.in, offset: c.start - c.in / (c.speed || 1), speed: c.speed || 1 });
            if (!parts.length)
                throw new BridgeError("NO_AUDIO", "No audio clips with media in the selection.");
        }
        const words = [];
        const segments = [];
        let language = "";
        for (const p of parts) {
            const r = await an.transcribe(p.file, { model: a.model, language: a.language, start: p.start, dur: p.dur, scriptDir });
            language = language || r.language;
            const map = (t) => an.r3(p.offset + t / p.speed);
            for (const s of r.segments)
                segments.push({ start: map(s.start), end: map(s.end), text: s.text });
            for (const w of r.words)
                words.push({ start: map(w.start), end: map(w.end), word: w.word, p: w.p });
        }
        words.sort((x, y) => x.start - y.start);
        const id = `tr_${Date.now().toString(36)}`;
        const json = path.join(transcriptDir, `${id}.json`);
        // source: how transcript times map back to media (file time, or sequence time of clips).
        const source = a.file ? { kind: "file", file: path.resolve(a.file) } : { kind: "sequence", parts: parts.map((p) => ({ file: p.file, in: p.start, dur: p.dur, offset: p.offset, speed: p.speed })) };
        fs.writeFileSync(json, JSON.stringify({ language, source, segments, words }), "utf-8");
        const res = { transcript: id, path: json, language, words: words.length, text: segments.map((s) => s.text).join(" ").slice(0, 4000), segments: segments.slice(0, 200) };
        if (a.captions) {
            const srt = json.replace(/\.json$/, ".srt");
            fs.writeFileSync(srt, cap.toSrt(cap.wordsToCues(words, a.max_chars || 32)), "utf-8");
            res.srt = srt;
        }
        return res;
    }, { async: true });
    const loadTranscript = (ref) => {
        const f = /^tr_/.test(ref) ? path.join(transcriptDir, `${ref}.json`) : path.resolve(ref);
        if (!fs.existsSync(f))
            throw new BridgeError("TRANSCRIPT_NOT_FOUND", `No transcript ${ref}.`, "Run transcribe first.");
        return JSON.parse(fs.readFileSync(f, "utf-8"));
    };
    ctx.loadTranscript = loadTranscript;
    tool("captions", "Captions", "Captions from transcripts or subtitle files. create_track (import an SRT/VTT, or a transcript, as a caption track), read (cues of a subtitle file or transcript), edit (replace text/times of cues by index and rewrite the file), retime (shift and/or stretch), export (SRT or VTT), safe_zone_check (caption block vs. the platform's UI-safe area: youtube, shorts, reels, tiktok, instagram_feed), burn_style (render styled PNG captions, optionally one card per word with the spoken word highlighted like Shorts, and place them on a video track). Premiere's scripting API cannot read caption tracks already in a sequence: read works on files and transcripts.", {
        action: z.enum(["create_track", "read", "edit", "retime", "export", "safe_zone_check", "burn_style"]),
        sequence: seqArg,
        source: z.string().optional().describe("Subtitle file (.srt/.vtt) or transcript id (tr_...)"),
        output: z.string().optional(),
        format: z.enum(["srt", "vtt"]).optional(),
        edits: z.array(z.object({ index: z.number().int(), text: z.string().optional(), start: z.number().optional(), end: z.number().optional() })).optional(),
        shift: z.number().optional(),
        factor: z.number().optional(),
        platform: z.enum(["youtube", "shorts", "reels", "tiktok", "instagram_feed"]).optional(),
        style: z
            .object({ font_family: z.string().optional(), font_file: z.string().optional(), size: z.number().optional(), color: z.string().optional(), highlight_color: z.string().optional(), stroke_color: z.string().optional(), stroke_width: z.number().optional(), uppercase: z.boolean().optional(), y: z.number().optional(), box: z.string().optional() })
            .optional(),
        word_highlight: z.boolean().optional().describe("burn_style: one card per word, current word highlighted"),
        track: track.optional(),
        max_chars: z.number().int().optional(),
        start: z.number().optional().describe("create_track: offset (s)"),
    }, ANN.write, async (a) => {
        const cuesFrom = (src) => {
            if (/^tr_/.test(src) || /\.json$/i.test(src))
                return cap.wordsToCues(loadTranscript(src).words, a.max_chars || 32);
            const f = path.resolve(src);
            if (!fs.existsSync(f))
                throw new BridgeError("FILE_NOT_FOUND", `File not found: ${f}`);
            return cap.parseSubtitles(fs.readFileSync(f, "utf-8"));
        };
        if (!a.source)
            throw new BridgeError("BAD_ARGS", "source (subtitle file or transcript id) is required.");
        let cues = cuesFrom(a.source);
        const write = (list, out) => {
            const fmt = a.format || (out && /\.vtt$/i.test(out) ? "vtt" : "srt");
            const file = path.resolve(out || path.join(transcriptDir, `captions_${Date.now().toString(36)}.${fmt}`));
            ensureOutputDir(path.dirname(file));
            fs.writeFileSync(file, fmt === "vtt" ? cap.toVtt(list) : cap.toSrt(list), "utf-8");
            return file;
        };
        if (a.action === "read")
            return { cues: cues.map(({ words, ...c }, i) => ({ index: i, ...c })), count: cues.length };
        if (a.action === "edit") {
            for (const e of a.edits || []) {
                const c = cues[e.index];
                if (!c)
                    throw new BridgeError("BAD_ARGS", `No cue ${e.index}.`);
                if (e.text !== undefined)
                    c.text = e.text;
                if (e.start !== undefined)
                    c.start = e.start;
                if (e.end !== undefined)
                    c.end = e.end;
            }
            const f = write(cues, a.output || (/\.(srt|vtt)$/i.test(a.source) ? a.source : undefined));
            return { path: f, edited: (a.edits || []).length, verified: cap.parseSubtitles(fs.readFileSync(f, "utf-8")).length === cues.length };
        }
        if (a.action === "retime") {
            cues = cap.retime(cues, a.shift || 0, a.factor || 1);
            const f = write(cues, a.output);
            return { path: f, cues: cues.length, first: cues[0], last: cues[cues.length - 1] };
        }
        if (a.action === "export") {
            const f = write(cues, a.output);
            return { path: f, cues: cues.length, format: a.format || path.extname(f).slice(1) };
        }
        if (a.action === "create_track") {
            const f = /\.(srt|vtt)$/i.test(a.source) && !a.max_chars ? path.resolve(a.source) : write(cues);
            return call("import_captions", { sequence: a.sequence, path: f, start: a.start }, 120000);
        }
        const st = await call("get_sequence_settings", { sequence: a.sequence });
        const W = st.width;
        const H = st.height;
        const style = a.style || {};
        const dir = path.join(transcriptDir, `cards_${Date.now().toString(36)}`);
        if (a.action === "safe_zone_check") {
            const platform = a.platform || (H > W ? "shorts" : "youtube");
            const blocks = cues.map((c, i) => ({ start: c.start, ...cap.renderCaptionCard(c.text, W, H, style, path.join(dir, `chk_${i}.png`)) }));
            fs.rmSync(dir, { recursive: true, force: true });
            const issues = cap.safeZoneIssues(blocks, platform);
            return { platform, zone: cap.SAFE_ZONES[platform], cues: cues.length, outside: issues.length, issues: issues.slice(0, 50) };
        }
        // burn_style
        const cards = [];
        cues.forEach((c, i) => {
            if (a.word_highlight && c.words?.length) {
                c.words.forEach((w, k) => {
                    const end = k + 1 < c.words.length ? c.words[k + 1].start : c.end;
                    cards.push({ path: cap.renderCaptionCard(c.text, W, H, style, path.join(dir, `c${i}_${k}.png`), k).path, start: w.start, end: Math.max(end, w.start + 0.05) });
                });
            }
            else
                cards.push({ path: cap.renderCaptionCard(c.text, W, H, style, path.join(dir, `c${i}.png`)).path, start: c.start, end: c.end });
        });
        const imp = await call("import_files", { paths: cards.map((c) => c.path), bin: "_MCP Plus/Captions" }, 600000);
        const byName = new Map(imp.imported.map((i) => [path.basename(i.media || i.name).toLowerCase(), i.id]));
        const clips = cards.map((c) => ({ item: byName.get(path.basename(c.path).toLowerCase()) || c.path, track: a.track || "V3", start: an.r3(c.start), duration: an.r3(Math.max(0.05, c.end - c.start)), media: "video" }));
        const placed = await call("place_clips", { sequence: a.sequence, clips, auto_create_tracks: true }, 120000 + clips.length * 3000);
        return { cards: cards.length, placed: placed.placed.length, errors: placed.errors, folder: dir, verified: placed.placed.length === cards.length };
    });
    // ======================================================== 2.8 review
    tool("review", "Review frames", "Contact sheet of review frames with timecodes: at every marker (by: markers), at the middle of every clip of a selector (by: clips), or every N seconds (by: interval). Returns the sheet image.", { sequence: seqArg, by: z.enum(["markers", "clips", "interval"]), clips: clipSelector.optional(), every: z.number().optional(), from: z.number().optional(), to: z.number().optional(), max: z.number().int().optional() }, ANN.read, async (a) => {
        let times = [];
        if (a.by === "markers")
            times = (await call("list_markers", { sequence: a.sequence })).markers.map((m) => m.start);
        else if (a.by === "clips")
            times = (await sources(a.sequence, a.clips ?? { kind: "video" })).clips.filter((c) => c.video).map((c) => an.r3((c.start + c.end) / 2));
        else {
            const st = await call("get_sequence_settings", { sequence: a.sequence });
            for (let t = a.from || 0; t < (a.to ?? st.duration); t += a.every || 5)
                times.push(an.r3(t));
        }
        times = [...new Set(times)].sort((x, y) => x - y).slice(0, Math.min(48, a.max || 24));
        if (!times.length)
            throw new BridgeError("NOTHING_TO_REVIEW", "No markers / clips / times found.");
        return ctx.registry.get("export_frames").handler({ sequence: a.sequence, times, contact_sheet: true });
    });
    // ======================================================== 2.9 delivery
    const PLATFORMS = {
        youtube: { w: 1920, h: 1080, lufs: -14, tp: -1, aspect: "16:9", preset: "Match Source - Adaptive High Bitrate|YouTube 1080p" },
        youtube_4k: { w: 3840, h: 2160, lufs: -14, tp: -1, aspect: "16:9", preset: "YouTube 2160p|Match Source - Adaptive High Bitrate" },
        shorts: { w: 1080, h: 1920, lufs: -14, tp: -1, aspect: "9:16", preset: "Match Source - Adaptive High Bitrate" },
        reels: { w: 1080, h: 1920, lufs: -14, tp: -1, aspect: "9:16", preset: "Match Source - Adaptive High Bitrate" },
        tiktok: { w: 1080, h: 1920, lufs: -14, tp: -1, aspect: "9:16", preset: "Match Source - Adaptive High Bitrate" },
        instagram_feed: { w: 1080, h: 1350, lufs: -14, tp: -1, aspect: "4:5", preset: "Match Source - Adaptive High Bitrate" },
    };
    const verifyFile = async (file, platform, expect = {}) => {
        const f = await an.deliveryFacts(file);
        const spec = platform ? PLATFORMS[platform] : null;
        const checks = [];
        const add = (name, ok, got, want) => checks.push({ check: name, ok, got, want });
        if (spec && f.video)
            add("resolution", f.video.width === spec.w && f.video.height === spec.h, `${f.video.width}x${f.video.height}`, `${spec.w}x${spec.h}`);
        if (expect.fps && f.video)
            add("fps", Math.abs(f.video.fps - expect.fps) < 0.02, f.video.fps, expect.fps);
        if (expect.duration)
            add("duration", Math.abs(f.duration - expect.duration) < 0.1, f.duration, expect.duration);
        if (f.video)
            add("video codec", /h264|hevc|prores/.test(f.video.codec), f.video.codec, "h264/hevc/prores");
        if (spec && f.loudness?.lufs !== null && f.loudness) {
            add("loudness", Math.abs(f.loudness.lufs - spec.lufs) <= 1, f.loudness.lufs, `${spec.lufs} ±1 LUFS`);
            add("true peak", (f.loudness.truePeak ?? -99) <= spec.tp + 0.1, f.loudness.truePeak, `<= ${spec.tp} dBTP`);
        }
        return { file, facts: f, checks, conformant: checks.every((c) => c.ok) };
    };
    ctx.verifyFile = verifyFile;
    ctx.PLATFORMS = PLATFORMS;
    tool("deliver", "Delivery", "Delivery for platforms. matrix: specs per platform (youtube, youtube_4k, shorts, reels, tiktok, instagram_feed: size, aspect, loudness -14 LUFS / -1 dBTP). verify: check a file with FFmpeg (resolution, fps, codec, duration, LUFS, true peak) against a platform -> conformance report. export: render many sequences and/or presets in one call (jobs), each verified. by_markers: one file per marker segment (chapters).", {
        action: z.enum(["matrix", "verify", "export", "by_markers"]),
        file: z.string().optional(),
        platform: z.enum(["youtube", "youtube_4k", "shorts", "reels", "tiktok", "instagram_feed"]).optional(),
        sequences: z.array(z.string()).optional(),
        sequence: seqArg,
        presets: z.array(z.string()).optional().describe("export: .epr paths (default: the platform's preset)"),
        folder: z.string().optional(),
        name_template: z.string().optional().describe('"{sequence}_{preset}" (default) or with {n} {marker} for by_markers'),
        marker_type: z.enum(["any", "chapter", "comment", "segmentation"]).optional(),
        use_media_encoder: z.boolean().optional(),
    }, ANN.write, async (a, jctx) => {
        if (a.action === "matrix")
            return { platforms: PLATFORMS };
        if (a.action === "verify") {
            if (!a.file)
                throw new BridgeError("BAD_ARGS", "file is required.");
            return verifyFile(path.resolve(a.file), a.platform);
        }
        const exp = ctx.registry.get("export_sequence").handler;
        const folder = path.resolve(a.folder || path.join(os.homedir(), "Videos", "Premiere MCP Plus"));
        ensureOutputDir(folder);
        const presetFor = (p) => (p ? [p] : a.presets?.length ? a.presets : [undefined]);
        if (a.action === "export") {
            const seqs = a.sequences?.length ? a.sequences : [a.sequence ?? ""];
            const out = [];
            let n = 0;
            const presets = presetFor();
            for (const s of seqs) {
                for (const pr of presets) {
                    jctx?.progress?.(n++ / (seqs.length * presets.length), `${s}`);
                    const st = await call("get_sequence_settings", { sequence: s || undefined });
                    const name = (a.name_template || "{sequence}_{preset}").replace("{sequence}", st.name).replace("{preset}", pr ? path.basename(pr, ".epr") : "default").replace(/[\\/:*?"<>|]/g, "_");
                    const r = await exp({ sequence: s || undefined, output: path.join(folder, name + ".mp4"), preset_path: pr, use_media_encoder: a.use_media_encoder, wait: true });
                    const v = r.path ? await verifyFile(r.path, a.platform, { duration: st.duration, fps: st.fps }) : null;
                    out.push({ sequence: st.name, preset: pr, path: r.path, conformant: v?.conformant, checks: v?.checks });
                }
            }
            return { files: out, verified: out.every((o) => o.path && fs.existsSync(o.path)) };
        }
        // by_markers
        const st = await call("get_sequence_settings", { sequence: a.sequence });
        const ms = (await call("list_markers", { sequence: a.sequence })).markers.filter((m) => !a.marker_type || a.marker_type === "any" || String(m.type).toLowerCase().includes(a.marker_type));
        if (!ms.length)
            throw new BridgeError("NO_MARKERS", "The sequence has no markers to split by.");
        ms.sort((x, y) => x.start - y.start);
        const out = [];
        for (let i = 0; i < ms.length; i++) {
            const s = ms[i].start;
            const e = ms[i].end > s + 0.01 ? ms[i].end : i + 1 < ms.length ? ms[i + 1].start : st.duration;
            if (e - s < 0.1)
                continue;
            jctx?.progress?.(i / ms.length, ms[i].name);
            await call("set_sequence_range", { sequence: a.sequence, in: s, out: e });
            const name = (a.name_template || "{n}_{marker}").replace("{n}", String(i + 1).padStart(2, "0")).replace("{marker}", ms[i].name || "segment").replace("{sequence}", st.name).replace(/[\\/:*?"<>|]/g, "_");
            const r = await exp({ sequence: a.sequence, output: path.join(folder, name + ".mp4"), preset_path: a.presets?.[0], range: "in_out", use_media_encoder: a.use_media_encoder, wait: true });
            out.push({ marker: ms[i].name, start: s, end: an.r3(e), path: r.path, duration: r.duration, verified: Math.abs((r.duration || 0) - (e - s)) < 0.15 });
        }
        return { segments: out, verified: out.every((o) => o.verified) };
    }, { async: true });
    tool("encode", "Media Encoder", "Queue work in Adobe Media Encoder: a project item (item), a sequence, or a loose file (file) with an .epr preset; launch AME; start the queue. wait: true blocks until the output exists and is a valid media file. AME's own queue cannot be read by script: queue status covers the jobs started here (see jobs with async: true).", {
        action: z.enum(["item", "sequence", "file", "launch", "start"]),
        item: z.string().optional(),
        sequence: seqArg,
        file: z.string().optional(),
        output: z.string().optional(),
        preset_path: z.string().optional(),
        range: z.enum(["entire", "in_out", "work_area"]).optional(),
        wait: z.boolean().optional(),
        timeout_s: z.number().optional(),
    }, ANN.write, async (a) => {
        if (a.action === "launch" || a.action === "start")
            return call("encode", a);
        if (!a.output || !a.preset_path)
            throw new BridgeError("BAD_ARGS", "output and preset_path are required.");
        const out = path.resolve(a.output);
        ensureOutputDir(path.dirname(out));
        if (a.action === "sequence")
            await call("save_project", {});
        const started = Date.now() - 2000;
        const r = await call("encode", { ...a, output: out, preset_path: path.resolve(a.preset_path), file: a.file ? path.resolve(a.file) : undefined }, 120000);
        if (!a.wait)
            return r;
        const stem = path.basename(out, path.extname(out));
        const end = Date.now() + (a.timeout_s || 1800) * 1000;
        while (Date.now() < end) {
            const f = fs.readdirSync(path.dirname(out)).find((x) => x.startsWith(stem) && fs.statSync(path.join(path.dirname(out), x)).mtimeMs > started);
            if (f) {
                const full = path.join(path.dirname(out), f);
                const ok = await media.waitForValidMedia(full, Math.max(5000, end - Date.now()));
                if (ok.valid)
                    return { ...r, done: true, path: full, duration: ok.duration, verified: true };
            }
            await new Promise((res) => setTimeout(res, 1500));
        }
        throw new BridgeError("AME_TIMEOUT", "Media Encoder did not write the output in time.", "Check the Media Encoder queue.");
    }, { async: true });
}
