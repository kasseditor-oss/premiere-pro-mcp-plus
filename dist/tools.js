import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { BridgeError, packageRoot } from "./bridge.js";
import { registerPhase2 } from "./tools2.js";
import { registerPhase3 } from "./tools3.js";
import { WIDGET_URI } from "./branding.js";
import { findPreset, loadPresets } from "./presets.js";
import { renderTitle } from "./titles.js";
import * as media from "./media.js";
import { buildEdl } from "./edl.js";
import { JobManager } from "./jobs.js";
import { CheckpointStore, diffTimelines } from "./checkpoint.js";
import { activeProfiles, confirmationsOn, consumeToken, issueToken, packTools, profileFor } from "./policy.js";
import sharp from "sharp";
const ANN = {
    // Only hints that differ from the MCP defaults (readOnly false, destructive true, idempotent false, openWorld true).
    read: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    write: { destructiveHint: false, openWorldHint: false },
    destructive: { openWorldHint: false },
};
// ---------- shared schemas
const seqArg = z.string().optional().describe("Sequence id/name (default: active)");
const track = z.string().regex(/^[VvAa]\d+$/).describe("V1, A2... (1-based)");
// Compact on purpose (it is in most tools' schemas): the host validates the keys.
const clipSelector = z
    .union([z.string(), z.array(z.string()), z.record(z.string(), z.any())])
    .describe("id, [ids] or {tracks,name_regex,kind,selected,at,start_min,start_max,every_nth,offset,limit}");
// Any property value (the host checks it against the property): number, boolean, string or [numbers].
const value = z.any().describe("num|bool|str|[num]");
const keySchema = z.object({
    t: z.union([z.number(), z.literal("end")]).describe('Seconds from clip start, or "end"'),
    v: value,
    interp: z.enum(["linear", "hold", "bezier", "ease"]).optional(),
    offset: z.number().optional().describe('With t:"end": seconds before the end'),
});
const animation = z.object({
    effect: z.string().optional().describe('default "Motion"'),
    property: z.string().describe('e.g. "Scale", "Position", "Rotation", "Opacity", "Blurriness"'),
    keys: z.array(keySchema),
    unit: z.enum(["px", "norm"]).optional().describe("For Position/Anchor arrays: pixels (default for px) or normalized 0-1"),
    interp: z.enum(["linear", "hold", "bezier", "ease"]).optional(),
    replace: z.boolean().optional().describe("Clear existing keys first"),
    time_base: z.enum(["clip", "sequence"]).optional().describe("Key times relative to clip start (default) or absolute sequence time"),
});
const transform = z.object({
    scale: z.number().optional().describe("Percent"),
    scale_width: z.number().optional(),
    position: z.array(z.number()).length(2).optional().describe("[x,y] in pixels of the sequence frame (center = [w/2,h/2])"),
    rotation: z.number().optional(),
    anchor: z.array(z.number()).length(2).optional(),
    opacity: z.number().optional().describe("Percent"),
    crop_left: z.number().optional(),
    crop_top: z.number().optional(),
    crop_right: z.number().optional(),
    crop_bottom: z.number().optional(),
    unit: z.enum(["px", "norm"]).optional(),
});
/** Create the folder an output goes to, or fail with a clear OUTPUT_PATH_INVALID error. */
function ensureOutputDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch (e) {
        const root = path.parse(dir).root;
        const why = root && !fs.existsSync(root) ? `the drive ${root} does not exist` : e?.code === "EACCES" || e?.code === "EPERM" ? "access is denied" : e?.code || String(e?.message || e);
        throw new BridgeError("OUTPUT_PATH_INVALID", `Cannot create the output folder ${dir}: ${why}.`, "Pass a path on an existing, writable drive.");
    }
}
function compact(v) {
    return JSON.stringify(v, (_k, x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x));
}
const projectArg = z.string().optional();
const expectedArg = z.string().optional();
// Tools that do not touch a project (or manage projects themselves).
const NO_PROJECT_ARG = new Set(["premiere_status", "bridge_stats", "jobs", "project_file", "analyze_media", "list_export_presets", "list_effect_presets", "batch", "undo", "recipes"]);
export function registerTools(server, bridge) {
    const scratch = path.join(os.tmpdir(), "premiere-mcp-plus", "frames");
    const jobs = new JobManager();
    const checkpoints = new CheckpointStore(bridge.dir);
    const profiles = activeProfiles();
    const pack = packTools();
    // Every tool, by name, for batch ops that use tool names (validated with the tool's own schema).
    const toolRegistry = new Map();
    const hidden = [];
    /** Clone the sequence as "<name> [checkpoint hh:mm:ss]" and keep a snapshot of its timeline. */
    async function makeCheckpoint(sequence, label, clone = true) {
        const tl = await call("get_timeline", { sequence, include_effects: true, include_media: true, skip_empty: true });
        const stamp = new Date().toTimeString().slice(0, 8);
        const id = "cp_" + Date.now().toString(36);
        let copy = null;
        if (clone)
            copy = await call("duplicate_sequence", { sequence: tl.id, name: `${tl.name} [checkpoint ${stamp}${label ? " " + label : ""}]` }, 60000);
        const cp = { id, createdAt: new Date().toISOString(), sequence: { id: tl.id, name: tl.name }, clone: copy ? { id: copy.id, name: copy.name } : undefined, label, timeline: tl };
        checkpoints.save(cp);
        return { checkpoint: id, sequence: cp.sequence, clone: cp.clone, clips: tl.tracks.reduce((n, t) => n + t.clips.length, 0) };
    }
    function statusOf(readOnly, out) {
        if (out && typeof out === "object" && typeof out.status === "string" && /^(verified|committed_unverified|failed|needs_confirmation|queued|ok)$/.test(out.status))
            return out.status;
        if (readOnly)
            return "ok";
        if (out && typeof out === "object") {
            if (out.verified === true)
                return "verified";
            if (out.verified === false)
                return "failed";
        }
        return "committed_unverified";
    }
    function tool(name, title, description, shape, annotations, handler, opts = {}) {
        // Authority: a tool outside the active permission profiles does not exist;
        // a tool outside the active packs is hidden from the model (batch can still run it).
        if (!profiles.has(profileFor(name)))
            return;
        // Every Premiere tool takes an optional project / expected_project_path: the
        // server makes that project active first (or fails with PROJECT_MISMATCH),
        // so a call never lands in another open project by accident.
        let full = NO_PROJECT_ARG.has(name) ? { ...shape } : { ...shape, project: projectArg, expected_project_path: expectedArg };
        if (opts.async)
            full = { ...full, async: z.boolean().optional().describe("Run as a background job: returns job_id at once (see jobs)") };
        if (opts.checkpoint)
            full = { ...full, checkpoint: z.boolean().optional().describe("Clone the sequence as a [checkpoint] first") };
        if (opts.confirm)
            full = { ...full, confirm_token: z.string().optional().describe("Token from the preview call (single use)") };
        const readOnly = annotations === ANN.read;
        const run = async (args, inBatch = false) => {
            args = { ...(args || {}) };
            if (args.project) {
                await call("select_project", { project: args.project }, 30000);
                delete args.project;
            }
            if (args.expected_project_path) {
                await call("check_project", { path: path.resolve(args.expected_project_path) }, 15000);
                delete args.expected_project_path;
            }
            if (opts.confirm && confirmationsOn()) {
                if (args.confirm_token)
                    consumeToken(name, args);
                else {
                    const preview = await opts.confirm(args);
                    if (preview)
                        return { status: "needs_confirmation", preview, confirm_token: issueToken(name, args), hint: "Repeat the same call with confirm_token to execute." };
                }
            }
            delete args.confirm_token;
            let cp = null;
            if (opts.checkpoint && args.checkpoint)
                cp = await makeCheckpoint(args.sequence);
            delete args.checkpoint;
            if (opts.async && args.async && !inBatch) {
                delete args.async;
                const id = jobs.start(name, (ctx) => handler(args, ctx));
                return { status: "queued", job_id: id, checkpoint: cp || undefined, hint: "jobs action 'wait' or 'status' with this job_id." };
            }
            delete args.async;
            const out = await handler(args);
            if (cp && out && typeof out === "object" && !Array.isArray(out.content))
                out.checkpoint = cp;
            return out;
        };
        toolRegistry.set(name, { schema: z.object(full), handler: (a) => run(a, true) });
        if (pack && !pack.has(name)) {
            hidden.push(name);
            return;
        }
        server.registerTool(name, {
            title,
            description,
            inputSchema: z.object(full),
            annotations,
            _meta: { ui: { resourceUri: WIDGET_URI } },
        }, (async (args) => {
            // Standard envelope: {ok, tool, status, data} or {ok:false, tool, status:"failed", error:{code, message, hint}}.
            try {
                const out = await run(args);
                const warn = !NO_PROJECT_ARG.has(name) && bridge.openProjects > 1 ? `${bridge.openProjects} projects are open; this acted on the active one.` : undefined;
                if (out && typeof out === "object" && Array.isArray(out.content)) {
                    const res = out;
                    const i = res.content.findIndex((c) => c.type === "text");
                    let data = i >= 0 ? res.content[i].text : null;
                    try {
                        data = JSON.parse(data);
                    }
                    catch {
                        /* plain text */
                    }
                    const env = res.isError ? { ok: false, tool: name, status: "failed", error: data } : { ok: true, tool: name, status: statusOf(readOnly, data), data, warning: warn };
                    if (i >= 0)
                        res.content[i] = { type: "text", text: compact(env) };
                    return res;
                }
                const status = statusOf(readOnly, out);
                if (out && typeof out === "object" && !Array.isArray(out)) {
                    delete out.status;
                    delete out.verified;
                }
                return { content: [{ type: "text", text: compact({ ok: true, tool: name, status, data: out, warning: warn }) }] };
            }
            catch (e) {
                const error = e instanceof BridgeError ? { code: e.code, message: e.message, hint: e.hint } : { code: e?.code || "SERVER_ERROR", message: String(e?.message || e) };
                return { isError: true, content: [{ type: "text", text: compact({ ok: false, tool: name, status: "failed", error }) }] };
            }
        }));
    }
    const call = (fn, args, timeoutMs) => bridge.call(fn, args, { timeoutMs });
    // Capability routing: an action goes to UXP when the plugin is connected and its
    // probe reports the API; otherwise CEP/QE. A write that fails on one backend is
    // never retried on the other (the error carries the backend).
    const UXP_ROUTES = { "markers.add": "markers.add", "playhead.set": "playhead.set" };
    async function viaUxp(action) {
        if (process.env.PREMIERE_MCP_PREFER_UXP === "0" || !bridge.uxp.connected)
            return false;
        const p = await bridge.uxp.probe();
        return !!p?.capabilities?.[UXP_ROUTES[action]];
    }
    const uxpCall = async (fn, args) => {
        try {
            return { ...(await bridge.uxp.call(fn, args)), backend: "uxp" };
        }
        catch (e) {
            throw new BridgeError(e.code || "UXP_ERROR", `${e.message} (UXP backend; not retried on CEP)`, e.hint);
        }
    };
    // ======================================================== status
    tool("premiere_status", "Premiere status", "Connection, Premiere version, open projects, active sequence, open dialogs, backends (CEP/UXP) and routes. Call first when unsure.", {}, ANN.read, async () => {
        const hb = bridge.heartbeat();
        if (!hb.alive)
            return { connected: false, bridgeDir: bridge.dir, heartbeatAgeMs: hb.ageMs, fix: "Open Premiere Pro (extension auto-starts). If never installed: run `premiere-pro-mcp-plus --install-cep` and restart Premiere." };
        const [ping, dialogs] = await Promise.all([call("ping", {}, 15000), bridge.openDialogs()]);
        const res = { connected: true, ...ping, busy: hb.busy, commandsServed: hb.count };
        const probe = await bridge.uxp.probe();
        res.backends = { cep: { connected: true, lib: ping.lib }, uxp: { state: bridge.uxp.state, port: bridge.uxp.port, version: probe?.version, capabilities: probe?.capabilities } };
        res.routes = Object.fromEntries(Object.entries(UXP_ROUTES).map(([k, cap]) => [k, probe?.capabilities?.[cap] ? "uxp" : "cep"]));
        if (dialogs.length)
            res.dialogs = dialogs.map((d) => ({ title: d.title, text: d.text.slice(0, 300) }));
        if (Number(String(ping.premiere).split(".")[0]) < 26)
            res.versionNote = `Premiere ${ping.premiere}: works through CEP; live tests and new features target 2026+.`;
        if (ping.projects && ping.projects.length > 1)
            res.warning = `${ping.projects.length} projects are open; tools act on the active one (${ping.project?.name}). Close the others or pass project to choose.`;
        return res;
    });
    // ======================================================== project
    tool("get_project", "Project overview", "Project name/path, item counts, sequences and the active sequence (size, fps, duration, tracks, playhead). compact: true omits the sequence list.", { compact: z.boolean().optional() }, ANN.read, (a) => call("get_state", a));
    tool("list_project_items", "List project items", "List bins, clips and sequences with their ids (filter by bin, type, name regex).", {
        bin: z.string().optional().describe('Bin path like "Footage/Day1"; default root'),
        recursive: z.boolean().optional().describe("Default true"),
        types: z.array(z.enum(["bin", "clip", "file", "sequence"])).optional(),
        name_regex: z.string().optional(),
        details: z.boolean().optional().describe("Include duration, fps, offline, label"),
        limit: z.number().int().optional().describe("Default 500"),
    }, ANN.read, (a) => call("list_project_items", a));
    tool("get_item_info", "Project item info", "Details of one project item: media path, duration, in/out, fps interpretation, markers count. metadata: true adds parsed fields (name, timebase, video/audio in/out and duration, label, XMP timecode...); raw_xml: true adds the full project metadata and XMP XML.", {
        item: z.string().describe("Node id, name, bin path or media path"),
        metadata: z.boolean().optional().describe("Parsed metadata fields"),
        raw_xml: z.boolean().optional().describe("Also return the complete, untruncated XML"),
    }, ANN.read, (a) => call("get_item_info", a));
    tool("import_media", "Import media", "Import files, a folder (optionally mirrored as bins) or a timeline/project (interchange: FCP XML, EDL, AAF, .prproj, AE comps). Returns the new item ids.", {
        paths: z.array(z.string()).optional().describe("Files to import"),
        folder: z.string().optional().describe("Import every media file in this folder"),
        recursive: z.boolean().optional(),
        mirror_folders_as_bins: z.boolean().optional(),
        bin: z.string().optional().describe("Target bin path (created if missing)"),
        as_image_sequence: z.boolean().optional(),
        interchange: z
            .object({ kind: z.enum(["fcp_xml", "edl", "aaf", "prproj", "ae_comps", "otio"]), path: z.string(), comps: z.array(z.string()).optional(), sequence_ids: z.array(z.string()).optional() })
            .optional()
            .describe("Timeline/project import"),
    }, ANN.write, async (a) => {
        if (a.interchange) {
            const k = a.interchange;
            if (k.kind === "otio")
                throw new BridgeError("UNSUPPORTED_IN_PREMIERE", "OTIO import is only available through Premiere's UXP API (25.6+), not ExtendScript.", "Export OTIO to FCP XML (e.g. with opentimelineio's otioconvert) and import that.");
            const kind = k.kind === "ae_comps" ? "ae_comps" : k.kind === "prproj" && k.sequence_ids?.length ? "sequences" : "file";
            return call("import_special", { kind, path: path.resolve(k.path), comps: k.comps, sequence_ids: k.sequence_ids, bin: a.bin }, 600000);
        }
        if (!a.paths?.length && !a.folder)
            throw new Error("Pass paths, folder or interchange.");
        const results = [];
        if (a.paths?.length)
            results.push(await call("import_files", { paths: a.paths.map((p) => path.resolve(p)), bin: a.bin, as_image_sequence: a.as_image_sequence }, 300000));
        if (a.folder) {
            const files = media.listMediaFiles(path.resolve(a.folder), !!a.recursive);
            const groups = new Map();
            for (const f of files) {
                const bin = a.mirror_folders_as_bins ? [a.bin, path.basename(a.folder), f.rel].filter(Boolean).join("/") : a.bin || "";
                if (!groups.has(bin))
                    groups.set(bin, []);
                groups.get(bin).push(f.file);
            }
            for (const [bin, paths] of groups)
                results.push(await call("import_files", { paths, bin: bin || undefined }, 600000));
        }
        const imported = results.flatMap((r) => r.imported);
        const missing = results.flatMap((r) => r.missing);
        return { imported, missing, count: imported.length };
    });
    tool("replace_media", "Replace / relink media", "Point a project item at a new file (all timeline uses update). With cache_bust (default true for stills) the file is copied under a new unique name first — this works around Premiere caching stills, which made the original MCP's refresh_media useless after editing a PNG.", { item: z.string(), path: z.string(), cache_bust: z.boolean().optional() }, ANN.write, async (a) => {
        let p = path.resolve(a.path);
        const still = /\.(png|jpe?g|tiff?|psd|bmp|gif|webp)$/i.test(p);
        if (a.cache_bust ?? still) {
            const ext = path.extname(p);
            const dest = path.join(path.dirname(p), `${path.basename(p, ext)}__v${Date.now().toString(36)}${ext}`);
            fs.copyFileSync(p, dest);
            p = dest;
        }
        return call("relink_media", { item: a.item, path: p });
    });
    tool("manage_bins", "Bins", "Create bins (nested paths) or move items into a bin.", { action: z.enum(["create", "move_items"]), bin: z.string().describe('Bin path, e.g. "Assets/SFX"'), items: z.array(z.string()).optional() }, ANN.write, (a) => (a.action === "create" ? call("create_bin", { path: a.bin }) : call("move_items", { bin: a.bin, items: a.items })));
    tool("manage_project_items", "Edit project items", "Rename, delete, set color label, set/clear source in/out, set frame-rate interpretation, refresh media, or create a subclip.", {
        action: z.enum(["rename", "delete", "label", "set_in_out", "clear_in_out", "interpret", "refresh", "subclip"]),
        items: z.array(z.string()).describe("Node ids / names"),
        name: z.string().optional(),
        label: z.number().int().min(0).max(15).optional(),
        in: z.number().optional(),
        out: z.number().optional(),
        fps: z.number().optional(),
        video: z.boolean().optional().describe("subclip: take video (default true)"),
        audio: z.boolean().optional().describe("subclip: take audio (default true)"),
        bin: z.string().optional(),
    }, ANN.destructive, async (a) => {
        const it = a.items[0];
        switch (a.action) {
            case "rename":
                return call("rename_item", { item: it, name: a.name });
            case "delete":
                return call("delete_items", { items: a.items });
            case "label":
                return call("set_item_label", { items: a.items, label: a.label });
            case "set_in_out":
                return call("set_item_in_out", { item: it, in: a.in, out: a.out });
            case "clear_in_out":
                return call("set_item_in_out", { item: it, clear: true });
            case "interpret":
                return call("set_interpretation", { item: it, fps: a.fps });
            case "refresh":
                return call("refresh_media", { items: a.items });
            case "subclip":
                return call("create_subclip", { item: it, name: a.name, in: a.in, out: a.out, video: a.video, audio: a.audio, bin: a.bin });
        }
    });
    tool("project_file", "Project file", "Save, save-as, open, create or close a project. new/open leave other projects open unless close_others: true (several open projects make it easy to act on the wrong one; premiere_status warns about it). close_others alone closes every project except the active one, without saving.", {
        action: z.enum(["save", "save_as", "open", "new", "close", "close_others"]),
        path: z.string().optional(),
        save: z.boolean().optional().describe("close: save first"),
        close_others: z.boolean().optional().describe("new/open: close every other open project (unsaved changes in them are discarded)"),
    }, ANN.write, async (a) => {
        if (a.action === "close_others")
            return call("close_other_projects", {});
        const map = { save: "save_project", save_as: "save_project_as", open: "open_project", new: "new_project", close: "close_project" };
        const r = await call(map[a.action], { path: a.path ? path.resolve(a.path) : undefined, save: a.save }, 420000);
        if ((a.action === "new" || a.action === "open") && a.close_others)
            r.closedOthers = (await call("close_other_projects", {})).closed;
        return r;
    }, {
        confirm: async (a) => {
            if (a.action !== "close_others" && !a.close_others)
                return null;
            const st = await call("ping", {});
            const others = (st.projects || []).filter((p) => !p.active).map((p) => p.path);
            return others.length ? { action: "close other projects without saving", projects: others } : null;
        },
    });
    // ======================================================== sequences
    tool("list_sequences", "List sequences", "All sequences with id, size, fps, duration, track counts; marks the active one.", {}, ANN.read, () => call("list_sequences", {}));
    tool("open_sequence", "Open sequence", "Open a sequence and make it active.", { sequence: z.string() }, ANN.write, (a) => call("open_sequence", a));
    tool("create_sequence", "Create sequence", "Create a sequence without dialogs: width/height/fps (e.g. 1080x1920 @30 for Shorts), preset_path (.sqpreset), from_clip (match a clip), or from_items (items placed in order).", {
        name: z.string(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        fps: z.number().optional(),
        sample_rate: z.number().optional(),
        preset_path: z.string().optional(),
        from_clip: z.string().optional().describe("Project item to match"),
        empty: z.boolean().optional().describe("With from_clip: remove the clip after creating"),
        from_items: z.array(z.string()).optional().describe("Build the sequence from these project items, in order (settings from the first)"),
        bin: z.string().optional(),
    }, ANN.write, (a) => (a.from_items?.length ? call("sequence_from_clips", { name: a.name, items: a.from_items, bin: a.bin }, 120000) : call("create_sequence", a, 60000)));
    tool("manage_sequence", "Edit sequence", "Rename, duplicate, delete, change settings (frame size/fps/sample rate), or set in/out, work area and playhead. No in/out point reads as null. The work area is switched on before it is set and re-read; Premiere 26.x ignores scripted work area changes, which returns WORK_AREA_UNSUPPORTED (use in/out instead).", {
        action: z.enum(["rename", "duplicate", "delete", "settings", "get_settings", "range", "zero_point", "format", "custom_property"]),
        sequence: seqArg,
        activate: z.boolean().optional().describe("duplicate: make the copy the active sequence (default false keeps the original active)"),
        seconds: z.number().optional().describe("zero_point: starting time (s)"),
        display_format: z.number().int().optional().describe("format: timecode display (e.g. 101 = 30 fps non-drop, 102 = 29.97 drop)"),
        field_type: z.number().int().optional().describe("format: 0 progressive, 1 upper, 2 lower"),
        par: z.string().optional().describe('format: pixel aspect ratio, e.g. "1,1"'),
        audio_channel_type: z.number().int().optional().describe("format: 0 mono, 1 stereo, 2 5.1, 3 multichannel"),
        max_bit_depth: z.boolean().optional(),
        max_render_quality: z.boolean().optional(),
        prop_name: z.string().optional().describe("custom_property: id"),
        prop_value: z.string().optional(),
        name: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        fps: z.number().optional(),
        sample_rate: z.number().optional(),
        in: z.number().optional(),
        out: z.number().optional(),
        work_in: z.number().optional(),
        work_out: z.number().optional(),
        playhead: z.number().optional(),
    }, ANN.destructive, (a) => {
        if (a.action === "zero_point" || a.action === "format")
            return call("sequence_extra", a);
        if (a.action === "custom_property")
            return call("sequence_extra", { ...a, name: a.prop_name, value: a.prop_value });
        const map = { rename: "rename_sequence", duplicate: "duplicate_sequence", delete: "delete_sequence", settings: "set_sequence_settings", get_settings: "get_sequence_settings", range: "set_sequence_range" };
        return call(map[a.action], a);
    }, {
        confirm: async (a) => {
            if (a.action !== "delete")
                return null;
            const st = await call("get_sequence_settings", { sequence: a.sequence });
            return { action: "delete sequence", sequence: { id: st.id, name: st.name, duration: st.duration } };
        },
    });
    tool("sequence_tools", "Sequence tools", "Advanced sequence operations: nest clips in place (their range on their tracks becomes a nested sequence), unnest (put a nest's clips back; effects not carried), render_previews / delete_previews, nest a range into a subsequence, Auto Reframe to another aspect ratio (e.g. 9:16), or Scene Edit Detection on selected clips (markers or cuts). Premiere 26.x runs Scene Edit Detection without creating anything, so the server then detects the cuts with FFmpeg and adds sequence markers or razor cuts itself (method: ffmpeg).", {
        action: z.enum(["subsequence", "auto_reframe", "scene_edit_detection", "nest", "unnest", "render_previews", "delete_previews"]),
        include_linked: z.boolean().optional(),
        audio: z.boolean().optional().describe("render_previews: audio only"),
        sequence: seqArg,
        activate: z.boolean().optional().describe("auto_reframe: make the new sequence active (default false keeps the original active)"),
        name: z.string().optional(),
        in: z.number().optional(),
        out: z.number().optional(),
        numerator: z.number().int().optional(),
        denominator: z.number().int().optional(),
        motion_preset: z.enum(["default", "slower", "faster"]).optional(),
        clips: clipSelector.optional(),
        detection_action: z.enum(["markers", "cuts"]).optional(),
        sensitivity: z.enum(["low", "medium", "high"]).optional(),
    }, ANN.write, async (a) => {
        if (a.action === "subsequence")
            return call("create_subsequence", a);
        if (a.action === "nest")
            return call("nest_clips", a, 120000);
        if (a.action === "unnest")
            return call("unnest_clip", a, 300000);
        if (a.action === "render_previews" || a.action === "delete_previews")
            return call("sequence_extra", a, 3600000);
        if (a.action === "auto_reframe")
            return call("auto_reframe", a, 600000);
        const act = a.detection_action === "cuts" ? "cuts" : "markers";
        const res = await call("scene_edit_detection", { ...a, action: act }, 600000);
        const sources = res.sources || [];
        delete res.sources;
        const found = act === "cuts" ? res.newClips?.length : res.markers?.length;
        if (found)
            return { ...res, method: "premiere" };
        // Premiere 26.x accepts performSceneEditDetectionOnSelection but creates
        // nothing, so detect the cuts with FFmpeg and apply them ourselves.
        const threshold = a.sensitivity === "high" ? 0.15 : a.sensitivity === "low" ? 0.5 : 0.3;
        const frame = 1 / 30;
        const markers = [];
        const cuts = [];
        const skipped = [];
        for (const s of sources) {
            if (!s.media || !fs.existsSync(s.media) || s.reversed) {
                skipped.push(`${s.id}: ${s.reversed ? "reversed clip" : "no media file"}`);
                continue;
            }
            const times = await media.detectScenes(s.media, threshold);
            for (const t of times) {
                if (t <= s.in + frame || t >= s.out - frame)
                    continue;
                const seqT = Math.round((s.start + (t - s.in) / (s.speed || 1)) * 1000) / 1000;
                if (seqT <= s.start + frame || seqT >= s.end - frame)
                    continue;
                if (act === "markers")
                    markers.push({ time: seqT, name: "Scene cut", comment: `${path.basename(s.media)} @ ${t}s` });
                else
                    cuts.push({ time: seqT, tracks: s.tracks });
            }
        }
        if (act === "markers") {
            const added = markers.length ? await call("add_markers", { sequence: a.sequence, markers }) : { added: [] };
            return { ok: true, action: act, method: "ffmpeg", threshold, markers: added.added, count: added.added.length, skipped: skipped.length ? skipped : undefined, note: "Premiere's Scene Edit Detection produced nothing; cuts were detected with FFmpeg and added as sequence markers." };
        }
        const made = [];
        for (const c of cuts)
            made.push(await call("razor", { sequence: a.sequence, times: [c.time], tracks: c.tracks }));
        return { ok: true, action: act, method: "ffmpeg", threshold, cutTimes: cuts.map((c) => c.time), cuts: made.reduce((n, r) => n + (r.cuts || 0), 0), skipped: skipped.length ? skipped : undefined, note: "Premiere's Scene Edit Detection produced nothing; cuts were detected with FFmpeg and razored on the clips' tracks." };
    }, { async: true });
    // ======================================================== timeline
    tool("get_timeline", "Read timeline", "Sequence snapshot: tracks with clips (id, name, start/end, in/out, effects, media) and transitions. Filter by tracks and time; compact: true returns one row per clip.", {
        sequence: seqArg,
        tracks: z.array(z.string()).optional(),
        start: z.number().optional(),
        end: z.number().optional(),
        include_effects: z.boolean().optional(),
        include_media: z.boolean().optional(),
        skip_empty: z.boolean().optional().describe("Omit tracks without clips (default true)"),
        compact: z.boolean().optional().describe("Rows [id,name,start,end,in,out]; fastest; cached until something changes"),
        fields: z.array(z.enum(["id", "name", "start", "end", "in", "out"])).optional().describe("compact: columns (fewer = faster)"),
    }, ANN.read, (a) => call("get_timeline", { skip_empty: true, ...a }));
    tool("manage_tracks", "Tracks", "Add video/audio tracks, delete a track, or set mute/lock/target/name on tracks.", {
        action: z.enum(["add", "delete", "set", "target_all", "target_none"]),
        sequence: seqArg,
        video: z.number().int().optional().describe("add: number of video tracks"),
        audio: z.number().int().optional().describe("add: number of audio tracks"),
        audio_type: z.enum(["mono", "stereo", "5.1", "adaptive"]).optional(),
        tracks: z.array(z.string()).optional().describe("delete/set: tracks"),
        mute: z.boolean().optional(),
        lock: z.boolean().optional(),
        target: z.boolean().optional(),
        name: z.string().optional(),
        force: z.boolean().optional().describe("delete even if the track has clips"),
    }, ANN.destructive, async (a) => {
        if (a.action === "add")
            return call("add_tracks", a);
        if (a.action === "target_all" || a.action === "target_none") {
            const tl = await call("get_timeline", { sequence: a.sequence, compact: true, skip_empty: false });
            return call("set_track", { sequence: a.sequence, tracks: tl.tracks.map((t) => t.track), target: a.action === "target_all" });
        }
        if (a.action === "delete") {
            const out = [];
            // delete from the highest index down so indices stay valid
            const list = [...(a.tracks || [])].sort((x, y) => parseInt(y.slice(1)) - parseInt(x.slice(1)));
            for (const t of list)
                out.push(await call("delete_track", { sequence: a.sequence, track: t, force: a.force }));
            return { deleted: out };
        }
        return call("set_track", a);
    });
    const placement = z.object({
        item: z.string().describe("Project item: node id, name, bin path, or media file path"),
        track: track.optional().describe("Default V1 (or A1 for media:'audio')"),
        start: z.number().describe("Timeline position (s)"),
        in: z.number().optional().describe("Source in (s)"),
        out: z.number().optional().describe("Source out (s)"),
        duration: z.number().optional().describe("Length on timeline (s); for stills sets the still length"),
        end: z.number().optional().describe("Timeline end (s), alternative to duration"),
        media: z.enum(["both", "video", "audio"]).optional().describe("video: picture only, never touches audio tracks"),
        audio_track: track.optional(),
        mode: z.enum(["overwrite", "insert"]).optional().describe("Default overwrite (never shifts other clips)"),
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        // Compact schemas here (place_clips is in every pack); the host validates each field.
        transform: z.record(z.string(), z.any()).optional().describe("{scale, position:[x,y] px, rotation, anchor, opacity, crop_left.., unit}"),
        effects: z.array(z.any()).optional().describe("['Gaussian Blur', {name, params}]"),
        keyframes: z.array(animation).optional(),
        properties: z
            .array(z.object({ effect: z.string().optional(), property: z.string(), value, unit: z.enum(["px", "norm"]).optional() }))
            .optional()
            .describe("[{effect, property, value}]"),
        volume_db: z.number().optional(),
    });
    tool("place_clips", "Place clips", "Build a timeline in ONE call: many items with in/out, duration, track, transform, effects, keyframes, properties, volume. media:'video' never touches audio tracks. Missing tracks are created; every clip is validated first and a clip that fails is removed with its linked audio. E.g. {clips:[{item:'clipA.mp4', track:'V1', start:0, in:2, out:6}]}", {
        sequence: seqArg,
        clips: z.array(placement).min(1),
        mode: z.enum(["overwrite", "insert"]).optional(),
        auto_create_tracks: z.boolean().optional().describe("Default true"),
        stop_on_error: z.boolean().optional(),
    }, ANN.write, (a) => call("place_clips", a, 120000 + a.clips.length * 3000), { checkpoint: true });
    tool("find_clips", "Find clips", "Find timeline clips with a selector (tracks, name_regex, at, selected, every_nth...). Returns ids, timing, media and effects.", { sequence: seqArg, clips: clipSelector.optional() }, ANN.read, (a) => call("find_clips", a));
    tool("edit_clips", "Edit clips", "Edit clips (linked audio follows unless include_linked:false; checked before editing). Actions: move (delta|to), move_to_track, trim (start/end/in/out/duration/trim_start/trim_end, keyframe_policy), set (enabled/name/label), link, unlink, slip/slide/roll (delta s), ripple_trim (edge, delta), duplicate (to, track), freeze_frame (at, duration), lift_range/extract_range (start..end), split_edit (audio_lead J / audio_tail L), batch_rename (pattern 'Cena {n:02}'). E.g. {action:'move', clips:{tracks:['V2']}, delta:1.5}", {
        action: z.enum(["move", "move_to_track", "trim", "set", "link", "unlink", "slip", "slide", "roll", "ripple_trim", "duplicate", "freeze_frame", "lift_range", "extract_range", "split_edit", "batch_rename"]),
        sequence: seqArg,
        clips: clipSelector.optional(),
        edge: z.enum(["start", "end"]).optional(),
        at: z.number().optional(),
        gap: z.number().optional(),
        ripple: z.boolean().optional(),
        tracks: z.array(z.string()).optional(),
        audio_lead: z.number().optional(),
        audio_tail: z.number().optional(),
        pattern: z.string().optional(),
        start_number: z.number().int().optional(),
        keyframe_policy: z.enum(["keep", "reject", "keep_relative"]).optional(),
        delta: z.number().optional(),
        to: z.number().optional(),
        track: track.optional(),
        start: z.number().optional(),
        end: z.number().optional(),
        in: z.number().optional(),
        out: z.number().optional(),
        duration: z.number().optional(),
        trim_start: z.number().optional(),
        trim_end: z.number().optional(),
        enabled: z.boolean().optional(),
        name: z.string().optional(),
        label: z.number().int().min(0).max(15).optional(),
        include_linked: z.boolean().optional(),
    }, ANN.write, async (a) => {
        if (!a.clips && !["lift_range", "extract_range"].includes(a.action))
            throw new BridgeError("BAD_ARGS", "clips is required.");
        switch (a.action) {
            case "slip":
            case "slide":
            case "roll":
                return call("edit_qe", a, 120000);
            case "ripple_trim":
            case "duplicate":
            case "lift_range":
            case "split_edit":
            case "batch_rename":
                return call("edit_misc", { ...a, start: a.start }, 120000);
            case "extract_range":
                return call("ripple_delete_ranges", { sequence: a.sequence, ranges: [{ start: a.start, end: a.end }], tracks: a.tracks }, 300000);
            case "freeze_frame": {
                const src = await call("clip_media", { sequence: a.sequence, clips: a.clips });
                const c = src.clips.find((x) => x.video);
                if (!c)
                    throw new BridgeError("BAD_ARGS", "freeze_frame needs a video clip.");
                const at = a.at ?? c.start;
                const pngPreset = media.findExportPresets("PNG Sequence \\(Match Source\\)").find((p) => !/Alpha/i.test(p.name) && /Premiere/i.test(p.path))?.path;
                const fr = await call("export_frame", { sequence: a.sequence, times: [at], folder: path.join(bridge.dir, "freeze"), png_preset: pngPreset }, 60000);
                const still = fr.frames?.[0]?.path;
                if (!still)
                    throw new BridgeError("FRAME_EXPORT_FAILED", "Could not render the frame to freeze.", fr.hint);
                return call("edit_misc", { ...a, clips: c.id, at, still_path: still }, 120000);
            }
            case "trim":
                if (a.keyframe_policy && a.keyframe_policy !== "keep") {
                    const before = await call("get_clip_effects", { sequence: a.sequence, clips: a.clips, include_values: true, limit: 50 });
                    const keyed = before.clips.flatMap((c) => c.components.flatMap((comp) => (comp.props || []).filter((p) => p.keyframes?.length).map((p) => ({ id: c.id, effect: comp.name, property: p.name, keys: p.keyframes.map((k) => k.t) }))));
                    if (a.keyframe_policy === "reject" && keyed.length) {
                        const dur = await call("find_clips", { sequence: a.sequence, clips: a.clips });
                        const lens = new Map(dur.clips.map((c) => [c.id, c.end - c.start]));
                        const ts0 = a.trim_start || 0;
                        const newLen = (id) => (a.duration ?? lens.get(id) - ts0 - (a.trim_end || 0));
                        const outside = keyed.filter((k) => k.keys.some((t) => t < ts0 - 0.001 || t - ts0 > newLen(k.id) + 0.001));
                        if (outside.length)
                            throw new BridgeError("KEYFRAMES_OUTSIDE", `Trim would leave keyframes outside ${outside.length} clip(s) (e.g. ${outside[0].property}).`, "Use keyframe_policy keep_relative or keep, or move the keys first (keyframe_tools).");
                    }
                    const r = await call("trim_clips", a);
                    if (a.keyframe_policy === "keep_relative" && a.trim_start)
                        for (const k of keyed)
                            await call("keyframe_tools", { sequence: a.sequence, clips: k.id, effect: k.effect, property: k.property, action: "move", delta: -a.trim_start }).catch(() => undefined);
                    return { ...r, keyframePolicy: a.keyframe_policy, keyedProperties: keyed.length };
                }
                return call("trim_clips", a);
            case "move":
                return call("move_clips", a);
            case "move_to_track":
                return call("move_clip_to_track", a);
            case "trim":
                return call("trim_clips", a);
            case "set":
                return call("set_clips", a);
            case "link":
                return call("link_clips", a);
            case "unlink":
                return call("link_clips", { ...a, unlink: true });
        }
    }, { checkpoint: true });
    tool("remove_clips", "Remove clips", "Delete clips (lift, or ripple: true to close the gap); linked clips too unless include_linked:false. Ripple-removing 10+ clips asks for a confirmation token.", { sequence: seqArg, clips: clipSelector, ripple: z.boolean().optional(), include_linked: z.boolean().optional().describe("default true") }, ANN.destructive, (a) => call("remove_clips", a), {
        checkpoint: true,
        // Ripple-removing many clips shifts the whole timeline: preview first.
        confirm: async (a) => {
            if (!a.ripple)
                return null;
            const found = await call("find_clips", { sequence: a.sequence, clips: a.clips });
            const n = (found.clips || found).length;
            return n >= 10 ? { action: "ripple remove", clips: n, note: "Every clip after each removed one moves left." } : null;
        },
    });
    tool("razor", "Razor cut", "Cut at one or many times on all tracks or given tracks (linked clips cut too unless include_linked:false). Returns real cuts; times with nothing to cut come back in skipped. E.g. {times:[3,7.5], tracks:['V1']}", { sequence: seqArg, times: z.array(z.number()).min(1), tracks: z.array(z.string()).optional(), include_linked: z.boolean().optional().describe("default true") }, ANN.write, (a) => call("razor", a), { checkpoint: true });
    tool("set_clip_speed", "Clip speed", "Change clip speed / reverse (QE). Speed 2 = 200%: the clip keeps its media range and its timeline length becomes duration/speed (ripple optional). Linked clips (the audio of a video clip) get the same speed and reverse, so they stay in sync. Works on razored pieces, including ones that end at the end of the media; the result is re-read from Premiere (speed, start/end, media in/out) and lists the linked clips changed.", {
        sequence: seqArg,
        clips: clipSelector,
        speed: z.number().positive().optional(),
        reverse: z.boolean().optional(),
        ripple: z.boolean().optional(),
        maintain_pitch: z.boolean().optional(),
        include_linked: z.boolean().optional().describe("Also change linked clips (default true)"),
        interpolation: z.enum(["frame_sampling", "frame_blending", "optical_flow"]).optional(),
        frame_blend: z.boolean().optional(),
        ramp: z.array(z.object({ at: z.number().describe("seconds from the clip start"), speed: z.number().positive() })).optional().describe("Speed ramp: the clip is cut at each 'at' and each piece gets its speed (time remapping is not scriptable); ripple keeps the pieces together"),
    }, ANN.write, async (a) => {
        if (a.ramp?.length) {
            const c = (await call("find_clips", { sequence: a.sequence, clips: a.clips })).clips.find((x) => !x.track.startsWith("A")) || (await call("find_clips", { sequence: a.sequence, clips: a.clips })).clips[0];
            const pts = [...a.ramp].sort((x, y) => x.at - y.at);
            const cuts = pts.map((p) => c.start + p.at).filter((t) => t > c.start + 0.02 && t < c.end - 0.02);
            if (cuts.length)
                await call("razor", { sequence: a.sequence, times: cuts, tracks: [c.track] });
            // Re-find the pieces left to right and set each speed (from the last piece back so ripple stays simple).
            const pieces = await call("find_clips", { sequence: a.sequence, clips: { tracks: [c.track], start_min: c.start - 0.01, start_max: c.end } });
            const list = pieces.clips.filter((x) => x.start >= c.start - 0.01 && x.start < c.end - 0.01).sort((x, y) => x.start - y.start);
            const speedAt = (rel) => { let s = a.speed; for (const p of pts)
                if (rel >= p.at - 0.02)
                    s = p.speed; return s; };
            const done = [];
            for (let i = list.length - 1; i >= 0; i--) {
                const sp = speedAt(list[i].start - c.start);
                if (Math.abs(sp - 1) < 1e-6) {
                    done.unshift({ id: list[i].id, speed: 1 });
                    continue;
                }
                const r = await call("set_speed", { sequence: a.sequence, clips: list[i].id, speed: sp, ripple: a.ripple !== false, include_linked: a.include_linked, maintain_pitch: a.maintain_pitch });
                done.unshift({ id: r.clips[0]?.id, speed: r.clips[0]?.speed, start: r.clips[0]?.start, end: r.clips[0]?.end });
            }
            return { ramp: done, pieces: done.length, verified: done.every((d, i) => Math.abs((d.speed || 1) - speedAt(list[i].start - c.start)) < 0.01) };
        }
        const out = a.speed ? await call("set_speed", a) : {};
        if (a.interpolation || a.frame_blend !== undefined)
            out.interpolation = await call("time_interpolation", a);
        return out;
    }, { checkpoint: true });
    tool("close_gaps", "Close gaps", "Ripple clips on given tracks left so no gaps remain (from an optional time).", { sequence: seqArg, tracks: z.array(z.string()), from: z.number().optional() }, ANN.write, (a) => call("close_gaps", a), { checkpoint: true });
    tool("select_clips", "Select clips", "Select clips in the timeline (e.g. to prepare for an interactive action) or read the current selection.", { sequence: seqArg, clips: clipSelector.optional(), read_only: z.boolean().optional().describe("Just return the current selection"), deselect_others: z.boolean().optional() }, ANN.write, (a) => (a.read_only ? call("get_selection", a) : call("select_clips", a)));
    // ======================================================== effects
    tool("list_available_effects", "Available effects", "List effect / transition names exactly as this (possibly localized) Premiere knows them.", { kind: z.enum(["video", "audio", "video_transition", "audio_transition"]).optional(), filter: z.string().optional().describe("Regex") }, ANN.read, (a) => call("list_available_effects", a));
    tool("get_clip_effects", "Clip effects", "Components on clips with every property value and keyframes (times relative to clip start).", { sequence: seqArg, clips: clipSelector, include_values: z.boolean().optional(), limit: z.number().int().optional() }, ANN.read, (a) => call("get_clip_effects", a));
    tool("apply_effects", "Apply effects", "Add effects to many clips, optionally with params: [{name:'Gaussian Blur', params:{Blurriness:30}}]. English names work on localized Premiere. Reports the real component and match name.", {
        sequence: seqArg,
        clips: clipSelector,
        effects: z.array(z.union([z.string(), z.object({ name: z.string(), params: z.record(z.string(), value).optional() })])).min(1),
    }, ANN.write, (a) => call("apply_effects", a, 120000));
    tool("remove_effects", "Remove effects", "Remove named effects (or all non-intrinsic effects) from clips.", { sequence: seqArg, clips: clipSelector, effects: z.array(z.string()).optional().describe("Omit to remove all added effects") }, ANN.destructive, (a) => call("remove_effects", a));
    tool("set_properties", "Set effect properties", "Set any effect parameter on many clips (static, or a single key with time). Colors accept '#RRGGBB'. Position arrays accept unit 'px'.", {
        sequence: seqArg,
        clips: clipSelector,
        set: z
            .array(z.object({ effect: z.string().optional(), property: z.string(), value, time: z.number().optional(), unit: z.enum(["px", "norm"]).optional() }))
            .min(1),
    }, ANN.write, (a) => call("set_properties", a));
    tool("set_transform", "Transform clips", "Motion/Opacity in friendly units on many clips: scale %, position px, rotation, anchor, opacity %, crop %, blend_mode by name.", { sequence: seqArg, clips: clipSelector, ...transform.shape, blend_mode: z.union([z.number().int(), z.string()]).optional().describe("multiply, screen, overlay... (pt-BR too) or index") }, ANN.write, (a) => call("set_transform", a));
    tool("add_keyframes", "Keyframes", "Animate properties on many clips; key times are seconds from each clip's start (or 'end', or sequence time with time_base). E.g. a 100->106 zoom: {clips:{tracks:['V1']}, animations:[{property:'Scale', keys:[{t:0,v:100},{t:'end',v:106}]}]}", { sequence: seqArg, clips: clipSelector, animations: z.array(animation).min(1) }, ANN.write, (a) => call("add_keyframes", a, 120000));
    tool("remove_keyframes", "Remove keyframes", "Remove all keyframes of a property (keeps the current value), or only within a clip-relative time range.", { sequence: seqArg, clips: clipSelector, effect: z.string().optional(), property: z.string(), from: z.number().optional(), to: z.number().optional() }, ANN.destructive, (a) => call("remove_keyframes", a));
    tool("copy_effects", "Copy effects", "Paste-attributes: copy effects, Motion/Opacity values and keyframes from one clip to others. keyframe_mode 'stretch' rescales key times to each target's length.", {
        sequence: seqArg,
        from: z.string().describe("Source clip id"),
        to: clipSelector,
        include_motion: z.boolean().optional(),
        keyframe_mode: z.enum(["relative", "stretch"]).optional(),
        attributes: z.array(z.enum(["motion", "opacity", "volume", "effects", "time_remapping"])).optional().describe("Paste Attributes: what to copy (default everything)"),
        effects: z.array(z.string()).optional().describe("With attributes 'effects': only these effects"),
    }, ANN.write, (a) => (a.attributes || a.effects ? call("paste_attributes", a, 120000) : call("copy_effects", a, 120000)));
    // ======================================================== presets (new)
    tool("list_effect_presets", "Effect presets", "List the user's saved Effect Presets (from Premiere's preset file) with their effects. NEW: the original MCP could not use presets at all.", { filter: z.string().optional(), details: z.boolean().optional() }, ANN.read, async (a) => {
        const { file, presets } = loadPresets();
        const re = a.filter ? new RegExp(a.filter, "i") : null;
        const list = presets
            .filter((p) => !re || re.test(p.path))
            .map((p) => a.details
            ? { path: p.path, effects: p.effects.map((e) => ({ effect: e.displayName, matchName: e.matchName, anchor: e.anchor, params: e.params.length, animated: e.params.filter((x) => x.keys).length })) }
            : { path: p.path, effects: p.effects.map((e) => e.displayName) });
        return { file, count: list.length, presets: list };
    });
    tool("apply_effect_preset", "Apply effect preset", "Apply a saved Effect Preset (by name or bin path, e.g. 'CANAL ANIME/personagem scala') to many clips: adds its effects and replays parameter values and keyframes, anchored to clip in/out like Premiere does.", {
        sequence: seqArg,
        clips: clipSelector,
        preset: z.string(),
        anchor: z.enum(["preset", "in", "out", "scale"]).optional().describe("Keyframe anchoring; default from the preset"),
    }, ANN.write, async (a) => {
        const { presets } = loadPresets();
        const p = findPreset(presets, a.preset);
        const effects = p.effects.map((e) => ({ ...e, anchor: a.anchor && a.anchor !== "preset" ? a.anchor : e.anchor }));
        const res = await call("apply_effect_spec", { sequence: a.sequence, clips: a.clips, effects }, 180000);
        return { preset: p.path, ...res };
    });
    tool("add_transitions", "Transitions", "Add a video or audio transition at the start/end/both of many clips (default Cross Dissolve / Constant Power).", {
        sequence: seqArg,
        clips: clipSelector,
        name: z.string().optional(),
        position: z.enum(["start", "end", "both"]).optional(),
        duration: z.number().optional().describe("Seconds, default 0.5"),
        alignment: z.enum(["center", "start", "end"]).optional(),
        single_sided: z.boolean().optional(),
    }, ANN.write, (a) => call("add_transitions", a, 120000));
    // ======================================================== audio
    tool("set_volume", "Clip volume", "Set clip level (db) or a dB envelope (keys [{t, db}]). Video clips act on their linked audio.", { sequence: seqArg, clips: clipSelector, db: z.number().optional(), keys: z.array(z.object({ t: z.number(), db: z.number() })).optional(), include_linked: z.boolean().optional().describe("default true") }, ANN.write, (a) => call("set_volume", a));
    tool("fade_audio", "Audio fades", "Fade audio clips in/out with volume keyframes (language-independent). Selected video clips act on their linked audio.", { sequence: seqArg, clips: clipSelector, fade_in: z.number().optional(), fade_out: z.number().optional(), level_db: z.number().optional(), include_linked: z.boolean().optional().describe("default true") }, ANN.write, (a) => call("fade_audio", a));
    // ======================================================== markers / playhead
    tool("markers", "Markers", "Sequence (or item) markers: list (type/color filter), add (batch), delete, update, export (csv | youtube chapters), import (CSV/TXT notes with timecodes). E.g. {action:'add', markers:[{time:12, name:'Parte 2', type:'chapter'}]}", {
        action: z.enum(["list", "add", "delete", "update", "export", "import"]),
        sequence: seqArg,
        item: z.string().optional().describe("Use the project item's clip markers instead"),
        guid: z.string().optional().describe("update: marker guid (or match by time / name_regex)"),
        update: z.object({ name: z.string().optional(), comment: z.string().optional(), color: z.number().int().min(0).max(7).optional(), duration: z.number().optional(), time: z.number().optional(), type: z.enum(["comment", "chapter", "segmentation", "web"]).optional(), url: z.string().optional() }).optional(),
        type: z.enum(["comment", "chapter", "segmentation", "web"]).optional().describe("list/export: only this type"),
        color: z.number().int().optional().describe("list/export: only this color"),
        format: z.enum(["csv", "youtube"]).optional().describe("export: CSV, or YouTube chapters text (00:00 Title)"),
        path: z.string().optional().describe("export file / import CSV-TXT"),
        markers: z
            .array(z.object({ time: z.number(), name: z.string().optional(), comment: z.string().optional(), duration: z.number().optional(), color: z.number().int().min(0).max(7).optional(), type: z.enum(["comment", "chapter", "segmentation", "web"]).optional(), url: z.string().optional() }))
            .optional(),
        time: z.number().optional(),
        name_regex: z.string().optional(),
        from: z.number().optional(),
        to: z.number().optional(),
    }, ANN.write, async (a) => {
        if (a.action === "update")
            return call("update_markers", a);
        if (a.action === "add") {
            const simple = !a.item && (a.markers || []).every((m) => !m.type && m.color === undefined && !m.url);
            if (simple && (await viaUxp("markers.add")))
                return uxpCall("add_markers", a);
            return call("add_markers", a);
        }
        if (a.action === "delete")
            return call("delete_markers", a);
        if (a.action === "import") {
            if (!a.path)
                throw new BridgeError("BAD_ARGS", "path is required.");
            const txt = fs.readFileSync(path.resolve(a.path), "utf-8").replace(/\r/g, "");
            const tc = (s) => { const p = s.trim().split(/[:;.]/).map(Number); if (p.some(isNaN))
                return NaN; return p.length === 4 ? p[0] * 3600 + p[1] * 60 + p[2] + p[3] / 30 : p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0]; };
            const markers = [];
            for (const line of txt.split("\n")) {
                if (!line.trim())
                    continue;
                let m = /^\s*([\d:;.]+)\s*[,;\t]\s*([^,;\t]*)(?:[,;\t]\s*(.*))?$/.exec(line) || /^\s*([\d:;.]+)\s+(.*)$/.exec(line);
                if (!m)
                    continue;
                const t = tc(m[1]);
                if (isNaN(t))
                    continue;
                markers.push({ time: t, name: (m[2] || "").trim(), comment: (m[3] || "").trim() || undefined, type: a.type });
            }
            if (!markers.length)
                throw new BridgeError("BAD_FILE", "No 'time, name[, comment]' lines found.");
            return call("add_markers", { sequence: a.sequence, item: a.item, markers });
        }
        const r = await call("list_markers", a);
        let list = r.markers;
        if (a.type)
            list = list.filter((m) => String(m.type).toLowerCase().includes(a.type));
        if (a.color !== undefined)
            list = list.filter((m) => m.color === a.color);
        if (a.action === "list")
            return { markers: list, count: list.length };
        const mmss = (t) => { const s = Math.floor(t); const h = Math.floor(s / 3600); const m = Math.floor(s / 60) % 60; const x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${String(m).padStart(2, "0")}:${x}`; };
        let text;
        if (a.format === "youtube") {
            const ch = [...list].sort((x, y) => x.start - y.start);
            if (!ch.length || ch[0].start > 0.5)
                ch.unshift({ start: 0, name: "Intro" });
            text = ch.map((m) => `${mmss(m.start)} ${m.name || "Chapter"}`).join("\n");
        }
        else
            text = "time,end,name,comment,type,color\n" + list.map((m) => [m.start, m.end, m.name, m.comment, m.type, m.color].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
        if (a.path) {
            ensureOutputDir(path.dirname(path.resolve(a.path)));
            fs.writeFileSync(path.resolve(a.path), text, "utf-8");
        }
        return { format: a.format || "csv", markers: list.length, text: text.slice(0, 5000), path: a.path ? path.resolve(a.path) : undefined, warning: a.format === "youtube" && list.length < 3 ? "YouTube needs at least 3 chapters, the first at 00:00, each >= 10 s." : undefined };
    });
    tool("playhead", "Playhead and playback", "Get/set the playhead (seconds) or action: next_edit, prev_edit, next_marker, prev_marker, clip (edge), start, end, play, stop, workspace (name).", {
        sequence: seqArg,
        seconds: z.number().optional(),
        action: z.enum(["next_edit", "prev_edit", "next_marker", "prev_marker", "clip", "start", "end", "play", "stop", "workspace"]).optional(),
        tracks: z.array(z.string()).optional(),
        clip: z.string().optional(),
        edge: z.enum(["start", "end"]).optional(),
        speed: z.number().optional(),
        name: z.string().optional().describe("workspace name"),
    }, ANN.write, async (a) => {
        if (a.action === "workspace")
            return call("workspace", a);
        if (a.action)
            return call("navigate", a);
        if (a.seconds === undefined)
            return call("get_playhead", a);
        if (await viaUxp("playhead.set"))
            return uxpCall("set_playhead", a);
        return call("set_playhead", a);
    });
    // ======================================================== export
    tool("export_frames", "Export frames", "Render sequence frames at times and SHOW them (contact sheet when >2) to verify edits visually; PNGs are kept on disk.", {
        sequence: seqArg,
        times: z.array(z.number()).min(1).max(48),
        folder: z.string().optional().describe("Where to keep PNGs; default temp"),
        contact_sheet: z.boolean().optional().describe("Default true when more than 2 frames"),
        columns: z.number().int().optional(),
        preview_width: z.number().int().optional().describe("Returned image width, default 960"),
        return_images: z.boolean().optional().describe("Default true"),
    }, ANN.read, async (a) => {
        const folder = path.resolve(a.folder || scratch);
        ensureOutputDir(folder);
        const pngPreset = media.findExportPresets("PNG Sequence \(Match Source\)").find((p) => !/Alpha/i.test(p.name) && /Premiere/i.test(p.path))?.path || media.findExportPresets("PNG").find((p) => !/Alpha/i.test(p.name))?.path;
        const res = await call("export_frame", { sequence: a.sequence, times: a.times, folder, png_preset: pngPreset }, 60000 + a.times.length * 15000);
        const frames = res.frames;
        const ok = frames.filter((f) => f.path);
        const content = [];
        const sheet = a.contact_sheet ?? ok.length > 2;
        if (a.return_images !== false && ok.length) {
            if (sheet) {
                const out = path.join(folder, `sheet_${Date.now()}.jpg`);
                await media.contactSheet(ok.map((f) => ({ path: f.path, label: `${f.time.toFixed(2)}s  ${f.timecode}` })), out, a.columns || (ok.length <= 4 ? 2 : 3), 480);
                content.push({ type: "image", data: await media.toPreviewJpeg(out, a.preview_width || 1440), mimeType: "image/jpeg" });
                res.sheet = out;
            }
            else {
                for (const f of ok)
                    content.push({ type: "image", data: await media.toPreviewJpeg(f.path, a.preview_width || 960), mimeType: "image/jpeg" });
            }
        }
        content.unshift({ type: "text", text: compact({ frames, sheet: res.sheet, failed: frames.length - ok.length, errors: res.errors, hint: res.hint }) });
        if (!ok.length)
            return { isError: true, content: [{ type: "text", text: compact({ error: "No frame could be rendered.", code: "FRAME_EXPORT_FAILED", hint: res.hint, details: res.errors }) }] };
        return { content, _meta: { "premiere-mcp-plus/summary": `${ok.length}/${frames.length} frames exportados` } };
    });
    tool("list_export_presets", "Export presets", "Find .epr export presets installed with Premiere / Media Encoder. filter is a regex matched against the preset name, its format (H.264, HEVC (H.265), Apple ProRes, QuickTime, Waveform Audio...) and its folder, e.g. 'H.264', 'ProRes 422', 'HEVC|H.264'. Each preset reports its format and folder.", { filter: z.string().optional() }, ANN.read, async (a) => {
        const list = media.findExportPresets(a.filter);
        return { count: list.length, presets: list.slice(0, 80) };
    });
    tool("export_sequence", "Export sequence", "Render a sequence to a file with an .epr preset (default H.264 Match Source), directly or via Media Encoder (wait: true waits for the file). range: entire|in_out|work_area. The file is checked with ffprobe. async: true runs it as a job.", {
        sequence: seqArg,
        output: z.string(),
        preset_path: z.string().optional().describe("Default: first 'Match Source - Adaptive High Bitrate' / H.264 preset found"),
        range: z.enum(["entire", "in_out", "work_area"]).optional(),
        use_media_encoder: z.boolean().optional(),
        wait: z.boolean().optional().describe("use_media_encoder: wait until the file exists and is a valid media file (default false)"),
        wait_timeout_s: z.number().optional().describe("Export timeout (direct, or AME with wait), default 1800"),
    }, ANN.write, async (a) => {
        // Fail fast on an unknown or empty sequence (before scanning preset folders).
        const seqInfo = await call("get_sequence_settings", { sequence: a.sequence }, 15000);
        if (!(seqInfo.duration > 0))
            throw new BridgeError("EMPTY_SEQUENCE", `Sequence '${seqInfo.name}' is empty; nothing to export.`, "Place clips first.");
        let preset = a.preset_path;
        if (!preset) {
            const list = media.findExportPresets("Match Source.*(High|Adaptive)|H\\.264");
            // Prefer Premiere's H.264 (.mp4) "Match Source - Adaptive High Bitrate";
            // AME's "H264 Match Source" preset writes QuickTime .mov.
            const rank = (p) => (/^Match Source - Adaptive High Bitrate$/i.test(p.name) ? 0 : /^Match Source - High bitrate$/i.test(p.name) ? 1 : /Match Source/i.test(p.name) ? 2 : 3) * 2 + (p.source === "Premiere" ? 0 : 1);
            preset = [...list].sort((x, y) => rank(x) - rank(y))[0]?.path;
            if (!preset)
                throw new Error("No export preset found; pass preset_path (see list_export_presets).");
        }
        // Transparent still used to pad a range that ends in a gap (see host export_media).
        const filler = path.join(bridge.dir, "mcp-filler.png");
        if (!fs.existsSync(filler))
            await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(filler);
        ensureOutputDir(path.dirname(path.resolve(a.output)));
        const out = path.resolve(a.output);
        const timeout = (a.wait_timeout_s || 1800) * 1000;
        const run = () => call("export_media", { sequence: a.sequence, path: out, preset_path: preset, range: a.range, use_media_encoder: a.use_media_encoder, filler_path: filler, keep_temp: true }, timeout);
        const startedAt = Date.now() - 2000;
        let res = await run();
        // The host renames the output to the preset's real extension (.mov...).
        const actual = res.path || out;
        if (res.queued) {
            if (!a.wait)
                return res;
            // Wait for AME: a new (or rewritten) file that ffprobe can read.
            const end = Date.now() + timeout;
            while (Date.now() < end) {
                if (fs.existsSync(actual) && fs.statSync(actual).mtimeMs > startedAt) {
                    const check = await media.waitForValidMedia(actual, Math.max(5_000, end - Date.now()));
                    if (check.valid)
                        return { ...res, done: true, bytes: fs.statSync(actual).size, duration: check.duration };
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
            throw new BridgeError("AME_TIMEOUT", `Media Encoder job ${res.jobId} did not produce ${actual} within ${Math.round(timeout / 1000)}s.`, "Check the Media Encoder queue for errors.");
        }
        // Premiere can return before the file is finalized: wait until it is a valid media file.
        let check = await media.waitForValidMedia(actual, 120_000);
        if (!check.valid) {
            if (res.tempSequence)
                await call("delete_sequence", { sequence: res.tempSequence }).catch(() => undefined);
            res = await run(); // one retry
            check = await media.waitForValidMedia(actual, 180_000);
        }
        if (res.tempSequence) {
            await call("delete_sequence", { sequence: res.tempSequence }).catch(() => undefined);
            delete res.tempSequence;
        }
        if (!check.valid)
            throw new Error(`Premiere wrote an incomplete file (${check.reason}). Keep the Premiere window visible and retry, or use use_media_encoder: true.`);
        return { ...res, status: "verified", bytes: fs.statSync(actual).size, duration: check.duration };
    }, { async: true });
    tool("export_interchange", "Export XML / EDL / AAF", "Export the sequence as Final Cut Pro XML (no 'Translation Report' dialog), CMX3600 EDL, AAF, OMF (audio), or a .prproj with just this sequence (project). Missing folders are created. When Premiere has no EDL exporter (26.x), the EDL is generated from the timeline (video_track + audio_tracks).", {
        sequence: seqArg,
        format: z.enum(["fcp_xml", "edl", "aaf", "omf", "project"]),
        path: z.string(),
        video_track: track.optional().describe("EDL: video track to list (default V1)"),
        audio_tracks: z.array(z.string()).optional().describe('EDL: audio tracks (default ["A1","A2"])'),
    }, ANN.write, async (a) => {
        const p = path.resolve(a.path);
        ensureOutputDir(path.dirname(p));
        if (a.format === "fcp_xml")
            return call("export_fcp_xml", { sequence: a.sequence, path: p }, 120000);
        if (a.format === "omf" || a.format === "project")
            return call("export_extra", { sequence: a.sequence, path: p, format: a.format }, 600000);
        if (a.format === "edl") {
            const r = await call("export_edl", { sequence: a.sequence, path: p }, 120000);
            if (r.nativeExport)
                return { path: p, generator: "premiere" };
            const tl = await call("get_timeline", { sequence: a.sequence, include_effects: false });
            const edl = buildEdl(tl, { videoTrack: a.video_track, audioTracks: a.audio_tracks });
            fs.writeFileSync(p, edl.text, "utf-8");
            return { path: p, generator: "premiere-mcp-plus (CMX3600 from timeline)", events: edl.events, bytes: fs.statSync(p).size };
        }
        const r = await call("export_aaf", { sequence: a.sequence, path: p }, 300000);
        // Premiere's "AAF Export Log" lists what AAF cannot carry; the bridge closes it.
        const log = (r.dialogsClosed || []).map((d) => d.text).join(" ");
        const ignored = [...log.matchAll(/Cannot export (video|audio) effect "([^"]+)"/g)].map((m) => `${m[1]}: ${m[2]}`);
        if (ignored.length || log)
            r.warning = ignored.length ? `AAF ignored ${ignored.length} unsupported effect(s): ${[...new Set(ignored)].join(", ")}` : log.slice(0, 400);
        if (ignored.length)
            r.ignoredEffects = [...new Set(ignored)];
        return r;
    });
    // ======================================================== text / graphics
    tool("create_title_image", "Title image", "Render a transparent PNG title with any .ttf/.otf font (e.g. Bebas Neue), fill, outline, underline and shadow; optionally import and place it on the timeline in the same call.", {
        output: z.string().describe("PNG path"),
        lines: z
            .array(z.object({
            text: z.string(),
            size: z.number().optional(),
            color: z.string().optional(),
            stroke_color: z.string().optional(),
            stroke_width: z.number().optional(),
            letter_spacing: z.number().optional(),
            underline: z.object({ color: z.string().optional(), thickness: z.number().optional(), offset: z.number().optional() }).optional(),
        }))
            .min(1),
        font_file: z.string().optional(),
        font_family: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        align: z.enum(["left", "center", "right"]).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        line_gap: z.number().optional(),
        shadow: z.union([z.literal(false), z.object({ dx: z.number().optional(), dy: z.number().optional(), blur: z.number().optional(), color: z.string().optional(), opacity: z.number().optional() })]).optional(),
        template: z.enum(["lower_third", "center_title", "counter", "chapter_tag"]).optional().describe("Ready layouts: lower_third (name + role bottom-left), center_title, counter (big number, e.g. rankings), chapter_tag (top-left tag)"),
        animate: z.object({ in: z.enum(["fade", "slide_up", "slide_left", "pop"]).optional(), out: z.enum(["fade", "slide_down", "slide_right", "pop"]).optional(), duration: z.number().optional() }).optional().describe("With place: entrance/exit keyframes (Opacity / Position / Scale)"),
        place: z.object({ sequence: seqArg, track: track.optional(), start: z.number(), duration: z.number().optional(), bin: z.string().optional() }).optional(),
        preview: z.boolean().optional().describe("Return the image (default true)"),
    }, ANN.write, async (a) => {
        const spec = { ...a, output: path.resolve(a.output) };
        const W = a.width ?? 1920;
        const H = a.height ?? 1080;
        const L = a.lines;
        if (a.template === "lower_third")
            Object.assign(spec, { align: "left", x: a.x ?? W * 0.06, y: a.y ?? H * 0.8, line_gap: a.line_gap ?? 8, lines: L.map((l, i) => ({ size: i ? H * 0.035 : H * 0.06, color: i ? "#DDDDDD" : "#FFFFFF", ...l, underline: i === 0 ? l.underline ?? { color: "#46C8FF" } : l.underline })) });
        if (a.template === "center_title")
            Object.assign(spec, { align: "center", lines: L.map((l, i) => ({ size: i ? H * 0.05 : H * 0.11, ...l })) });
        if (a.template === "counter")
            Object.assign(spec, { align: "center", y: a.y ?? H * 0.6, lines: L.map((l, i) => ({ size: i ? H * 0.06 : H * 0.3, stroke_color: "#000000", stroke_width: H * 0.008, ...l })) });
        if (a.template === "chapter_tag")
            Object.assign(spec, { align: "left", x: a.x ?? W * 0.04, y: a.y ?? H * 0.1, lines: L.map((l) => ({ size: H * 0.045, letter_spacing: 2, ...l })), shadow: a.shadow ?? { dx: 3, dy: 3, blur: 3 } });
        const r = renderTitle(spec);
        const out = { title: r };
        if (a.place) {
            const imp = await call("import_files", { paths: [r.path], bin: a.place.bin || "_MCP Plus/Titles" });
            const id = imp.imported[0]?.id;
            if (!id)
                throw new Error("Title was rendered but not imported.");
            out.placed = await call("place_clips", { sequence: a.place.sequence, clips: [{ item: id, track: a.place.track || "V2", start: a.place.start, duration: a.place.duration ?? 3 }] });
            const clipId = out.placed.placed?.[0]?.id;
            if (a.animate && clipId) {
                const d = a.animate.duration ?? 0.4;
                const W2 = await call("get_sequence_settings", { sequence: a.place.sequence });
                const cx = W2.width / 2;
                const cy = W2.height / 2;
                const anims = [];
                const op = [];
                const pos = [];
                const sc = [];
                if (a.animate.in === "fade")
                    op.push({ t: 0, v: 0 }, { t: d, v: 100 });
                if (a.animate.in === "slide_up")
                    pos.push({ t: 0, v: [cx, cy + W2.height * 0.08] }, { t: d, v: [cx, cy], interp: "ease" });
                if (a.animate.in === "slide_left")
                    pos.push({ t: 0, v: [cx + W2.width * 0.1, cy] }, { t: d, v: [cx, cy], interp: "ease" });
                if (a.animate.in === "pop")
                    sc.push({ t: 0, v: 0 }, { t: d * 0.7, v: 110 }, { t: d, v: 100 });
                if (a.animate.out === "fade")
                    op.push({ t: "end", offset: d, v: 100 }, { t: "end", v: 0 });
                if (a.animate.out === "slide_down")
                    pos.push({ t: "end", offset: d, v: [cx, cy] }, { t: "end", v: [cx, cy + W2.height * 0.08] });
                if (a.animate.out === "slide_right")
                    pos.push({ t: "end", offset: d, v: [cx, cy] }, { t: "end", v: [cx + W2.width * 0.1, cy] });
                if (a.animate.out === "pop")
                    sc.push({ t: "end", offset: d, v: 100 }, { t: "end", v: 0 });
                if (op.length)
                    anims.push({ effect: "Opacity", property: "Opacity", keys: op });
                if (pos.length)
                    anims.push({ property: "Position", unit: "px", keys: pos });
                if (sc.length)
                    anims.push({ property: "Scale", keys: sc });
                if (anims.length)
                    out.animation = await call("add_keyframes", { sequence: a.place.sequence, clips: clipId, animations: anims });
            }
        }
        const content = [{ type: "text", text: compact(out) }];
        if (a.preview !== false)
            content.push({ type: "image", data: await media.toPreviewJpeg(r.path, 640), mimeType: "image/jpeg" });
        return { content };
    });
    tool("mogrt", "Motion Graphics Templates", "Import a .mogrt onto the timeline (with text/params filled in; save_recipe keeps it for reuse), batch (many MOGRTs or recipes with different params in one call), read its editable params, or set params on existing MOGRT clips. Premiere's native text MOGRTs do not expose their text to scripts: use create_title_image for those.", {
        action: z.enum(["import", "get_params", "set_params", "batch"]),
        sequence: seqArg,
        path: z.string().optional(),
        items: z
            .array(z.object({ path: z.string().optional(), recipe: z.string().optional(), track: track.optional(), start: z.number(), duration: z.number().optional(), params: z.record(z.string(), value).optional() }))
            .optional()
            .describe("batch: many MOGRTs (or saved recipes) with their own params in one call"),
        save_recipe: z.string().optional().describe("import: also save path + params as a reusable recipe with this name"),
        track: track.optional(),
        start: z.number().optional(),
        duration: z.number().optional(),
        clips: clipSelector.optional(),
        params: z.record(z.string(), value).optional().describe('e.g. {"Text": "Hello", "Color": "#46C8FF"}'),
    }, ANN.write, async (a) => {
        const recipesFile = path.join(bridge.dir, "mogrt-recipes.json");
        const recipes = fs.existsSync(recipesFile) ? JSON.parse(fs.readFileSync(recipesFile, "utf-8")) : {};
        if (a.action === "batch") {
            const out = [];
            for (const it of a.items || []) {
                const r = it.recipe ? recipes[it.recipe] : null;
                if (it.recipe && !r) {
                    out.push({ start: it.start, error: `Unknown recipe ${it.recipe}` });
                    continue;
                }
                const spec = { sequence: a.sequence, path: path.resolve(it.path || r.path), track: it.track || r?.track, start: it.start, duration: it.duration ?? r?.duration, params: { ...(r?.params || {}), ...(it.params || {}) } };
                try {
                    out.push({ start: it.start, ...(await call("import_mogrt", spec, 120000)) });
                }
                catch (e) {
                    out.push({ start: it.start, error: e.message, code: e.code });
                }
            }
            return { results: out, placed: out.filter((o) => !o.error).length, failed: out.filter((o) => o.error).length, verified: out.every((o) => !o.error) };
        }
        if (a.action === "import") {
            const r = await call("import_mogrt", { ...a, path: a.path ? path.resolve(a.path) : undefined }, 120000);
            if (a.save_recipe) {
                recipes[a.save_recipe] = { path: path.resolve(a.path), track: a.track, duration: a.duration, params: a.params };
                fs.writeFileSync(recipesFile, JSON.stringify(recipes, null, 1));
                r.recipe = a.save_recipe;
            }
            return r;
        }
        if (a.action === "get_params")
            return call("get_mogrt_params", a);
        return call("set_mogrt_params", a);
    });
    tool("import_captions", "Import captions", "Import an .srt/.scc/.vtt file and create a caption track on the sequence.", { sequence: seqArg, path: z.string(), start: z.number().optional(), format: z.enum(["subtitle", "open", "608", "708"]).optional() }, ANN.write, (a) => call("import_captions", { ...a, path: path.resolve(a.path) }, 120000));
    // ======================================================== analysis (local ffmpeg)
    tool("analyze_media", "Analyze media", "Analyze a media file locally with FFmpeg (no Premiere needed): probe streams, detect silences (for jump cuts), detect scene cuts, measure loudness (LUFS), or grab source frames as images.", {
        action: z.enum(["probe", "silence", "scenes", "loudness", "frames"]),
        file: z.string(),
        noise_db: z.number().optional(),
        min_silence: z.number().optional(),
        threshold: z.number().optional().describe("Scene threshold 0-1, default 0.3"),
        times: z.array(z.number()).optional().describe("frames: source times"),
    }, ANN.read, async (a) => {
        const f = path.resolve(a.file);
        if (!fs.existsSync(f))
            throw new BridgeError("FILE_NOT_FOUND", `File not found: ${f}`, "Check the path (absolute paths are safest).");
        switch (a.action) {
            case "probe":
                return media.probe(f);
            case "silence": {
                const s = await media.detectSilence(f, a.noise_db ?? -35, a.min_silence ?? 0.4);
                return { silences: s, count: s.length, totalSilence: Math.round(s.reduce((x, y) => x + y.duration, 0) * 100) / 100 };
            }
            case "scenes": {
                const c = await media.detectScenes(f, a.threshold ?? 0.3);
                return { cuts: c, count: c.length };
            }
            case "loudness":
                return media.loudness(f);
            case "frames": {
                const times = a.times?.length ? a.times : [0];
                const files = await media.extractFrames(f, times, scratch);
                const sheet = path.join(scratch, `src_sheet_${Date.now()}.jpg`);
                await media.contactSheet(files.map((p, i) => ({ path: p, label: `${times[i]}s` })), sheet, times.length <= 4 ? 2 : 3);
                return { content: [{ type: "text", text: compact({ frames: files, sheet }) }, { type: "image", data: await media.toPreviewJpeg(sheet, 1440), mimeType: "image/jpeg" }] };
            }
        }
    }, { async: true });
    // ======================================================== power tools
    tool("run_extendscript", "Run ExtendScript", "Escape hatch: run ExtendScript in Premiere. The code is a function body; use `return` to send back a JSON-serializable value. `H` exposes every host handler and `helpers` has getSequence/selectClips/resolveItem/tsec. The language is ES3: no let/const, arrow functions, template strings, Array.map/forEach or JSON object. Reserved words cannot be literal keys: `{in: 1}` fails with \"Illegal use of reserved word 'in'\"; write `o[\"in\"] = 1` (same for class, default, new...).", { code: z.string() }, ANN.destructive, (a) => call("eval_script", a, 120000));
    tool("batch", "Batch operations", "Run several tool calls in order (stops at the first error unless continue_on_error). ops: [{fn:'<tool name>', args:{...}}], e.g. [{fn:'markers', args:{action:'add', markers:[{time:5}]}}, {fn:'playhead', args:{seconds:5}}]. Host handler names also work; consecutive ones share one Premiere round trip. Images are dropped.", { ops: z.array(z.object({ fn: z.string(), args: z.record(z.string(), z.any()).optional() })).min(1), continue_on_error: z.boolean().optional() }, ANN.write, async (a) => {
        const results = [];
        let hostRun = [];
        let stop = false;
        const flush = async () => {
            if (!hostRun.length)
                return;
            const r = await call("batch", { ops: hostRun, continue_on_error: a.continue_on_error }, 300000);
            for (const x of r.results)
                results.push(x);
            if (r.results.some((x) => !x.ok) && !a.continue_on_error)
                stop = true;
            hostRun = [];
        };
        for (const op of a.ops) {
            if (stop)
                break;
            const t = op.fn === "batch" ? undefined : toolRegistry.get(op.fn);
            if (!t) {
                // Raw host handler names: need the edit profile; eval_script needs unsafe-script.
                const need = op.fn === "eval_script" ? "unsafe-script" : "edit";
                if (!profiles.has(need)) {
                    results.push({ ok: false, fn: op.fn, code: "PERMISSION_DENIED", error: `'${op.fn}' is not available with the active permission profiles (${[...profiles].join(", ")}).` });
                    if (!a.continue_on_error)
                        break;
                    continue;
                }
                hostRun.push({ fn: op.fn, args: op.args || {} });
                continue;
            }
            await flush();
            if (stop)
                break;
            const parsed = t.schema.safeParse(op.args || {});
            if (!parsed.success) {
                results.push({ ok: false, fn: op.fn, code: "BAD_ARGS", error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
                if (!a.continue_on_error)
                    break;
                continue;
            }
            try {
                let data = await t.handler(parsed.data);
                if (data && Array.isArray(data.content)) {
                    // A tool that returned MCP content: keep its text part.
                    const txt = data.content.find((c) => c.type === "text")?.text;
                    if (data.isError)
                        throw Object.assign(new Error(txt || "error"), { code: "TOOL_ERROR" });
                    try {
                        data = JSON.parse(txt);
                    }
                    catch {
                        data = txt;
                    }
                }
                results.push({ ok: true, fn: op.fn, data });
            }
            catch (e) {
                results.push({ ok: false, fn: op.fn, error: String(e?.message || e), code: e?.code || "SERVER_ERROR" });
                if (!a.continue_on_error)
                    break;
            }
        }
        if (!stop)
            await flush();
        const failed = results.filter((r) => !r.ok).length;
        const res = { results, failed };
        if (failed)
            res.validOps = "tool names: " + [...toolRegistry.keys()].filter((k) => k !== "batch").join(", ");
        return res;
    });
    tool("undo", "Undo / redo", "Undo/redo whole tool calls: calls: N (default 1) rewinds Premiere's steps and the DOM edits of the last N calls; redo: true redoes them; steps: N is raw Ctrl+Z; history: true lists recorded calls. Fails with UNDO_STACK_CHANGED after manual edits.", {
        calls: z.number().int().min(1).max(50).optional().describe("Undo (or with redo: true, redo) the last N tool calls"),
        steps: z.number().int().min(1).max(50).optional().describe("Raw Premiere undo/redo steps"),
        redo: z.boolean().optional().describe("Redo instead of undo"),
        history: z.boolean().optional().describe("List the recorded calls instead of undoing"),
    }, ANN.write, (a) => {
        if (a.history)
            return call("undo_history", {});
        if (a.redo)
            return call("redo", a.steps === undefined ? { calls: a.calls ?? 1 } : { steps: a.steps });
        if (a.calls === undefined && a.steps === undefined)
            return call("undo", { calls: 1 });
        return call("undo", a);
    });
    // ======================================================== architecture (jobs, checkpoints, stats)
    tool("jobs", "Background jobs", "Follow async: true tools. action status|wait (timeout_s, default 60)|list|cancel; reports state, progress, ETA, result or error.", { action: z.enum(["status", "wait", "list", "cancel"]), job_id: z.string().optional(), timeout_s: z.number().optional() }, ANN.read, async (a) => {
        if (a.action === "list")
            return { jobs: jobs.list() };
        if (!a.job_id)
            throw new BridgeError("BAD_ARGS", "job_id is required.");
        if (a.action === "status")
            return jobs.status(a.job_id);
        if (a.action === "cancel")
            return jobs.cancel(a.job_id);
        return jobs.wait(a.job_id, Math.min(600, a.timeout_s ?? 60) * 1000);
    });
    tool("checkpoint", "Checkpoints and diff", "create: clone the sequence as '<name> [checkpoint hh:mm:ss]' and keep a snapshot of its clips (clone: false keeps only the snapshot). list: saved checkpoints. diff: compare two sequences, or a checkpoint (from) with the sequence now or another checkpoint (to): clips added, removed, moved, trimmed, changed (speed, effects, enabled). restore: duplicate the checkpoint's clone as '<name> (restored)' and open it.", {
        action: z.enum(["create", "list", "diff", "restore"]),
        sequence: seqArg,
        label: z.string().optional(),
        clone: z.boolean().optional().describe("create: also clone the sequence (default true)"),
        from: z.string().optional().describe("diff: checkpoint id or sequence (default: the latest checkpoint of the sequence)"),
        to: z.string().optional().describe("diff: checkpoint id or sequence (default: the sequence now)"),
        checkpoint_id: z.string().optional().describe("restore: checkpoint id"),
    }, ANN.write, async (a) => {
        if (a.action === "create")
            return { status: "verified", ...(await makeCheckpoint(a.sequence, a.label, a.clone !== false)) };
        if (a.action === "list")
            return { checkpoints: checkpoints.list() };
        if (a.action === "restore") {
            const cp = checkpoints.get(a.checkpoint_id || "");
            if (!cp)
                throw new BridgeError("CHECKPOINT_NOT_FOUND", `No checkpoint ${a.checkpoint_id}.`, "checkpoint action 'list'.");
            if (!cp.clone)
                throw new BridgeError("CHECKPOINT_HAS_NO_CLONE", "This checkpoint kept only a snapshot (clone: false); there is no sequence to restore.");
            const copy = await call("duplicate_sequence", { sequence: cp.clone.id, name: `${cp.sequence.name} (restored)`, activate: true }, 60000);
            return { status: "verified", restored: copy, from: cp.clone };
        }
        // diff
        const load = async (ref, fallbackSeq) => {
            if (ref && /^cp_/.test(ref)) {
                const cp = checkpoints.get(ref);
                if (!cp)
                    throw new BridgeError("CHECKPOINT_NOT_FOUND", `No checkpoint ${ref}.`);
                return { label: `${ref} (${cp.sequence.name} @ ${cp.createdAt})`, tl: cp.timeline };
            }
            const tl = await call("get_timeline", { sequence: ref || fallbackSeq, include_effects: true, include_media: true, skip_empty: true });
            return { label: `${tl.name} (now)`, tl };
        };
        let fromRef = a.from;
        if (!fromRef) {
            const seq = await call("get_sequence_settings", { sequence: a.sequence });
            const latest = checkpoints.list().find((c) => c.sequence.id === seq.id || c.sequence.name === seq.name);
            if (!latest)
                throw new BridgeError("CHECKPOINT_NOT_FOUND", "No checkpoint of this sequence yet.", "Pass from (a checkpoint id or a sequence), or create one first.");
            fromRef = latest.id;
        }
        const x = await load(fromRef);
        const y = await load(a.to, a.sequence);
        return { from: x.label, to: y.label, ...diffTimelines(x.tl, y.tl) };
    });
    tool("bridge_stats", "Bridge statistics", "Local telemetry: calls, errors, average/max time per host function (round trip and inside Premiere), queue depth, recent errors, backends.", { reset: z.boolean().optional() }, ANN.read, async (a) => {
        const fns = [...bridge.stats.entries()]
            .map(([fn, s]) => ({ fn, calls: s.calls, errors: s.errors, avgMs: Math.round(s.totalMs / Math.max(1, s.calls)), avgHostMs: Math.round(s.hostMs / Math.max(1, s.calls)), maxMs: s.maxMs, lastMs: s.lastMs }))
            .sort((x, y) => y.calls * y.avgMs - x.calls * x.avgMs);
        const out = {
            uptimeS: Math.round((Date.now() - bridge.startedAt) / 1000),
            queueDepth: bridge.queueDepth,
            busy: bridge.heartbeat().busy,
            functions: fns,
            recentErrors: bridge.recentErrors.slice(-10),
            backends: { cep: bridge.heartbeat().alive ? "connected" : "not connected", uxp: bridge.uxp.state },
            jobs: jobs.list().filter((j) => j.state === "running").length,
            profiles: [...profiles],
            hiddenByPack: hidden.length ? hidden : undefined,
        };
        if (a.reset) {
            bridge.stats.clear();
            bridge.recentErrors.length = 0;
        }
        return out;
    });
    const ctx = { tool, call, ANN, seqArg, clipSelector, track, scratch, ensureOutputDir, bridge, jobs, packageRoot, registry: toolRegistry, makeCheckpoint, server };
    registerPhase2(ctx);
    registerPhase3(ctx);
}
