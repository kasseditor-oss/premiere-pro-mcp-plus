import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BridgeError, PremiereBridge } from "./bridge.js";
import { WIDGET_URI } from "./branding.js";
import { findPreset, loadPresets } from "./presets.js";
import { renderTitle } from "./titles.js";
import * as media from "./media.js";
import { buildEdl } from "./edl.js";
import sharp from "sharp";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult {
  content: Content[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [k: string]: unknown;
}

const ANN = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

// ---------- shared schemas
const seqArg = z.string().optional().describe("Sequence id or name. Default: active sequence.");
const track = z.string().regex(/^[VvAa]\d+$/).describe('Track like "V1", "V2", "A1" (1-based, as in Premiere).');
const clipSelector = z
  .union([
    z.string().describe("A clip id"),
    z.array(z.string()).describe("Clip ids"),
    z.object({
      ids: z.array(z.string()).optional(),
      tracks: z.array(z.string()).optional().describe('e.g. ["V2","V5"]'),
      name_regex: z.string().optional(),
      kind: z.enum(["video", "audio"]).optional(),
      selected: z.boolean().optional().describe("Only clips selected in the timeline"),
      at: z.number().optional().describe("Clips under this time (s)"),
      start_min: z.number().optional(),
      start_max: z.number().optional(),
      every_nth: z.number().int().optional(),
      offset: z.number().int().optional(),
      limit: z.number().int().optional(),
    }),
  ])
  .describe("Which timeline clips: id, id list, or a selector object (filters combine with AND). Ids come from get_timeline / place_clips.");
const value = z.union([z.number(), z.boolean(), z.string(), z.array(z.number())]);
const keySchema = z.object({
  t: z.union([z.number(), z.literal("end")]).describe('Seconds from clip start, or "end"'),
  v: value,
  interp: z.enum(["linear", "hold", "bezier", "ease"]).optional(),
  offset: z.number().optional().describe('With t:"end": seconds before the end'),
});
const animation = z.object({
  effect: z.string().optional().describe('Component, default "Motion". Accepts display or match name ("Opacity", "Gaussian Blur").'),
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
function ensureOutputDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    const root = path.parse(dir).root;
    const why = root && !fs.existsSync(root) ? `the drive ${root} does not exist` : e?.code === "EACCES" || e?.code === "EPERM" ? "access is denied" : e?.code || String(e?.message || e);
    throw new BridgeError("OUTPUT_PATH_INVALID", `Cannot create the output folder ${dir}: ${why}.`, "Pass a path on an existing, writable drive.");
  }
}

function compact(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x));
}

export function registerTools(server: McpServer, bridge: PremiereBridge) {

  const scratch = path.join(os.tmpdir(), "premiere-mcp-plus", "frames");

  function tool<S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    shape: S,
    annotations: (typeof ANN)[keyof typeof ANN],
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown | ToolResult>,
  ) {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: z.object(shape),
        annotations: { title, ...annotations },

        _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] }, "ui/resourceUri": WIDGET_URI },
      } as any,
      (async (args: any) => {
        try {
          const out = await handler(args);
          if (out && typeof out === "object" && Array.isArray((out as ToolResult).content)) return out as ToolResult;
          return { content: [{ type: "text", text: compact(out) }] };
        } catch (e: any) {
          const err = e instanceof BridgeError ? { error: e.message, code: e.code, hint: e.hint } : { error: String(e?.message || e), code: "SERVER_ERROR" };
          return { isError: true, content: [{ type: "text", text: compact(err) }] };
        }
      }) as any,
    );
  }
  const call = (fn: string, args: object, timeoutMs?: number) => bridge.call(fn, args as Record<string, unknown>, { timeoutMs });

  // ======================================================== status
  tool("premiere_status", "Premiere status", "Check the connection to Premiere Pro and get version, open project, active sequence, bridge health. Call first when unsure.", {}, ANN.read, async () => {
    const hb = bridge.heartbeat();
    if (!hb.alive) return { connected: false, bridgeDir: bridge.dir, heartbeatAgeMs: hb.ageMs, fix: "Open Premiere Pro (extension auto-starts). If never installed: run `premiere-pro-mcp-plus --install-cep` and restart Premiere." };
    const ping = await call("ping", {}, 15000);
    return { connected: true, ...ping, busy: hb.busy, commandsServed: hb.count };
  });

  // ======================================================== project
  tool("get_project", "Project overview", "Project name/path, item counts, all sequences, and the active sequence summary (size, fps, duration, tracks, playhead).", {}, ANN.read, () => call("get_state", {}));

  tool(
    "list_project_items",
    "List project items",
    "List bins/clips/sequences in the project panel with ids (node ids) used by other tools.",
    {
      bin: z.string().optional().describe('Bin path like "Footage/Day1"; default root'),
      recursive: z.boolean().optional().describe("Default true"),
      types: z.array(z.enum(["bin", "clip", "file", "sequence"])).optional(),
      name_regex: z.string().optional(),
      details: z.boolean().optional().describe("Include duration, fps, offline, label"),
      limit: z.number().int().optional().describe("Default 500"),
    },
    ANN.read,
    (a) => call("list_project_items", a),
  );

  tool(
    "get_item_info",
    "Project item info",
    "Details of one project item: media path, duration, in/out, fps interpretation, markers count. metadata: true adds parsed fields (name, timebase, video/audio in/out and duration, label, XMP timecode...); raw_xml: true adds the full project metadata and XMP XML.",
    {
      item: z.string().describe("Node id, name, bin path or media path"),
      metadata: z.boolean().optional().describe("Parsed metadata fields"),
      raw_xml: z.boolean().optional().describe("Also return the complete, untruncated XML"),
    },
    ANN.read,
    (a) => call("get_item_info", a),
  );

  tool(
    "import_media",
    "Import media",
    "Import files or whole folders into the project (optionally into a bin; folder structure can be mirrored as bins). Returns the new item ids. FCP XML / .prproj / .srt also accepted as files.",
    {
      paths: z.array(z.string()).optional().describe("Files to import"),
      folder: z.string().optional().describe("Import every media file in this folder"),
      recursive: z.boolean().optional(),
      mirror_folders_as_bins: z.boolean().optional(),
      bin: z.string().optional().describe("Target bin path (created if missing)"),
      as_image_sequence: z.boolean().optional(),
    },
    ANN.write,
    async (a) => {
      if (!a.paths?.length && !a.folder) throw new Error("Pass paths or folder.");
      const results: any[] = [];
      if (a.paths?.length) results.push(await call("import_files", { paths: a.paths.map((p) => path.resolve(p)), bin: a.bin, as_image_sequence: a.as_image_sequence }, 300000));
      if (a.folder) {
        const files = media.listMediaFiles(path.resolve(a.folder), !!a.recursive);
        const groups = new Map<string, string[]>();
        for (const f of files) {
          const bin = a.mirror_folders_as_bins ? [a.bin, path.basename(a.folder), f.rel].filter(Boolean).join("/") : a.bin || "";
          if (!groups.has(bin)) groups.set(bin, []);
          groups.get(bin)!.push(f.file);
        }
        for (const [bin, paths] of groups) results.push(await call("import_files", { paths, bin: bin || undefined }, 600000));
      }
      const imported = results.flatMap((r) => r.imported);
      const missing = results.flatMap((r) => r.missing);
      return { imported, missing, count: imported.length };
    },
  );

  tool(
    "replace_media",
    "Replace / relink media",
    "Point a project item at a new file (all timeline uses update). With cache_bust (default true for stills) the file is copied under a new unique name first — this works around Premiere caching stills, which made the original MCP's refresh_media useless after editing a PNG.",
    { item: z.string(), path: z.string(), cache_bust: z.boolean().optional() },
    ANN.write,
    async (a) => {
      let p = path.resolve(a.path);
      const still = /\.(png|jpe?g|tiff?|psd|bmp|gif|webp)$/i.test(p);
      if (a.cache_bust ?? still) {
        const ext = path.extname(p);
        const dest = path.join(path.dirname(p), `${path.basename(p, ext)}__v${Date.now().toString(36)}${ext}`);
        fs.copyFileSync(p, dest);
        p = dest;
      }
      return call("relink_media", { item: a.item, path: p });
    },
  );

  tool(
    "manage_bins",
    "Bins",
    "Create bins (nested paths) or move items into a bin.",
    { action: z.enum(["create", "move_items"]), bin: z.string().describe('Bin path, e.g. "Assets/SFX"'), items: z.array(z.string()).optional() },
    ANN.write,
    (a) => (a.action === "create" ? call("create_bin", { path: a.bin }) : call("move_items", { bin: a.bin, items: a.items })),
  );

  tool(
    "manage_project_items",
    "Edit project items",
    "Rename, delete, set color label, set/clear source in/out, set frame-rate interpretation, refresh media, or create a subclip.",
    {
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
    },
    ANN.destructive,
    async (a) => {
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
    },
  );

  tool(
    "project_file",
    "Project file",
    "Save, save-as, open, create or close a project.",
    { action: z.enum(["save", "save_as", "open", "new", "close"]), path: z.string().optional(), save: z.boolean().optional().describe("close: save first") },
    ANN.write,
    (a) => {
      const map: Record<string, string> = { save: "save_project", save_as: "save_project_as", open: "open_project", new: "new_project", close: "close_project" };
      return call(map[a.action], { path: a.path ? path.resolve(a.path) : undefined, save: a.save }, 420000);
    },
  );

  // ======================================================== sequences
  tool("list_sequences", "List sequences", "All sequences with id, size, fps, duration, track counts; marks the active one.", {}, ANN.read, () => call("list_sequences", {}));

  tool("open_sequence", "Open sequence", "Open a sequence in the timeline and make it active.", { sequence: z.string() }, ANN.write, (a) => call("open_sequence", a));

  tool(
    "create_sequence",
    "Create sequence",
    "Create a sequence without any dialog: from explicit settings (e.g. 1080x1920 @30 for Shorts), from a .sqpreset, or matching a clip's settings (optionally empty).",
    {
      name: z.string(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      fps: z.number().optional(),
      sample_rate: z.number().optional(),
      preset_path: z.string().optional(),
      from_clip: z.string().optional().describe("Project item to match"),
      empty: z.boolean().optional().describe("With from_clip: remove the clip after creating"),
      bin: z.string().optional(),
    },
    ANN.write,
    (a) => call("create_sequence", a, 60000),
  );

  tool(
    "manage_sequence",
    "Edit sequence",
    "Rename, duplicate, delete, change settings (frame size/fps/sample rate), or set in/out, work area and playhead. No in/out point reads as null. The work area is switched on before it is set and re-read; Premiere 26.x ignores scripted work area changes, which returns WORK_AREA_UNSUPPORTED (use in/out instead).",
    {
      action: z.enum(["rename", "duplicate", "delete", "settings", "get_settings", "range"]),
      sequence: seqArg,
      activate: z.boolean().optional().describe("duplicate: make the copy the active sequence (default false keeps the original active)"),
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
    },
    ANN.destructive,
    (a) => {
      const map: Record<string, string> = { rename: "rename_sequence", duplicate: "duplicate_sequence", delete: "delete_sequence", settings: "set_sequence_settings", get_settings: "get_sequence_settings", range: "set_sequence_range" };
      return call(map[a.action], a);
    },
  );

  tool(
    "sequence_tools",
    "Sequence tools",
    "Advanced sequence operations: nest a range into a subsequence, Auto Reframe to another aspect ratio (e.g. 9:16), or Scene Edit Detection on selected clips (markers or cuts). Premiere 26.x runs Scene Edit Detection without creating anything, so the server then detects the cuts with FFmpeg and adds sequence markers or razor cuts itself (method: ffmpeg).",
    {
      action: z.enum(["subsequence", "auto_reframe", "scene_edit_detection"]),
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
    },
    ANN.write,
    async (a) => {
      if (a.action === "subsequence") return call("create_subsequence", a);
      if (a.action === "auto_reframe") return call("auto_reframe", a, 600000);
      const act = a.detection_action === "cuts" ? "cuts" : "markers";
      const res: any = await call("scene_edit_detection", { ...a, action: act }, 600000);
      const sources: any[] = res.sources || [];
      delete res.sources;
      const found = act === "cuts" ? res.newClips?.length : res.markers?.length;
      if (found) return { ...res, method: "premiere" };
      // Premiere 26.x accepts performSceneEditDetectionOnSelection but creates
      // nothing, so detect the cuts with FFmpeg and apply them ourselves.
      const threshold = a.sensitivity === "high" ? 0.15 : a.sensitivity === "low" ? 0.5 : 0.3;
      const frame = 1 / 30;
      const markers: { time: number; name: string; comment: string }[] = [];
      const cuts: { time: number; tracks: string[] }[] = [];
      const skipped: string[] = [];
      for (const s of sources) {
        if (!s.media || !fs.existsSync(s.media) || s.reversed) {
          skipped.push(`${s.id}: ${s.reversed ? "reversed clip" : "no media file"}`);
          continue;
        }
        const times = await media.detectScenes(s.media, threshold);
        for (const t of times) {
          if (t <= s.in + frame || t >= s.out - frame) continue;
          const seqT = Math.round((s.start + (t - s.in) / (s.speed || 1)) * 1000) / 1000;
          if (seqT <= s.start + frame || seqT >= s.end - frame) continue;
          if (act === "markers") markers.push({ time: seqT, name: "Scene cut", comment: `${path.basename(s.media)} @ ${t}s` });
          else cuts.push({ time: seqT, tracks: s.tracks });
        }
      }
      if (act === "markers") {
        const added: any = markers.length ? await call("add_markers", { sequence: a.sequence, markers }) : { added: [] };
        return { ok: true, action: act, method: "ffmpeg", threshold, markers: added.added, count: added.added.length, skipped: skipped.length ? skipped : undefined, note: "Premiere's Scene Edit Detection produced nothing; cuts were detected with FFmpeg and added as sequence markers." };
      }
      const made: any[] = [];
      for (const c of cuts) made.push(await call("razor", { sequence: a.sequence, times: [c.time], tracks: c.tracks }));
      return { ok: true, action: act, method: "ffmpeg", threshold, cutTimes: cuts.map((c) => c.time), cuts: made.reduce((n, r) => n + (r.cuts || 0), 0), skipped: skipped.length ? skipped : undefined, note: "Premiere's Scene Edit Detection produced nothing; cuts were detected with FFmpeg and razored on the clips' tracks." };
    },
  );

  // ======================================================== timeline
  tool(
    "get_timeline",
    "Read timeline",
    "Compact snapshot of a sequence: tracks (mute/lock/target) with clips (id, name, start/end, source in/out, effects, media), transitions. Filter by tracks and time window to keep it small.",
    {
      sequence: seqArg,
      tracks: z.array(z.string()).optional(),
      start: z.number().optional(),
      end: z.number().optional(),
      include_effects: z.boolean().optional(),
      include_media: z.boolean().optional(),
      skip_empty: z.boolean().optional().describe("Omit tracks without clips (default true)"),
    },
    ANN.read,
    (a) => call("get_timeline", { skip_empty: true, ...a }),
  );

  tool(
    "manage_tracks",
    "Tracks",
    "Add video/audio tracks, delete a track, or set mute/lock/target/name on tracks.",
    {
      action: z.enum(["add", "delete", "set"]),
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
    },
    ANN.destructive,
    async (a) => {
      if (a.action === "add") return call("add_tracks", a);
      if (a.action === "delete") {
        const out = [];
        // delete from the highest index down so indices stay valid
        const list = [...(a.tracks || [])].sort((x, y) => parseInt(y.slice(1)) - parseInt(x.slice(1)));
        for (const t of list) out.push(await call("delete_track", { sequence: a.sequence, track: t, force: a.force }));
        return { deleted: out };
      }
      return call("set_track", a);
    },
  );

  const placement = z.object({
    item: z.string().describe("Project item: node id, name, bin path, or media file path"),
    track: track.optional().describe("Default V1 (or A1 for media:'audio')"),
    start: z.number().describe("Timeline position (s)"),
    in: z.number().optional().describe("Source in (s)"),
    out: z.number().optional().describe("Source out (s)"),
    duration: z.number().optional().describe("Length on timeline (s); for stills sets the still length"),
    end: z.number().optional().describe("Timeline end (s), alternative to duration"),
    media: z.enum(["both", "video", "audio"]).optional().describe("'video' places picture only and never touches audio tracks (fixes original add_to_timeline pushing/overwriting the voice-over)"),
    audio_track: track.optional(),
    mode: z.enum(["overwrite", "insert"]).optional().describe("Default overwrite (never shifts other clips)"),
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    transform: transform.optional(),
    effects: z.array(z.union([z.string(), z.object({ name: z.string(), params: z.record(z.string(), value).optional() })])).optional(),
    keyframes: z.array(animation).optional(),
    properties: z
      .array(z.object({ effect: z.string().optional(), property: z.string(), value, unit: z.enum(["px", "norm"]).optional() }))
      .optional()
      .describe("Static parameter values set after effects are added, e.g. {effect:'Gaussian Blur', property:'Amount', value:30}"),
    volume_db: z.number().optional(),
  });
  tool(
    "place_clips",
    "Place clips",
    "Build a timeline in ONE call: place many project items (with source in/out, duration, track, video-only, transform, effects, keyframes, volume). Missing tracks are created automatically. Each clip is validated before the timeline is touched (start >= 0, 0 <= in < out <= media length, known effects, valid tracks); if anything fails after the edit, that clip and its linked audio are removed, so an error never leaves a clip behind. Returns the new clip ids and per-clip errors.",
    {
      sequence: seqArg,
      clips: z.array(placement).min(1),
      mode: z.enum(["overwrite", "insert"]).optional(),
      auto_create_tracks: z.boolean().optional().describe("Default true"),
      stop_on_error: z.boolean().optional(),
    },
    ANN.write,
    (a) => call("place_clips", a, 120000 + a.clips.length * 3000),
  );

  tool(
    "find_clips",
    "Find clips",
    "Find timeline clips with a selector (tracks, name regex, time, selection, every_nth...). Returns ids, timing, media and effects.",
    { sequence: seqArg, clips: clipSelector.optional() },
    ANN.read,
    (a) => call("find_clips", a),
  );

  tool(
    "edit_clips",
    "Edit clips",
    "Move (by delta or to a time), move to another track, trim (start/end/in/out/duration, or trim_start/trim_end amounts), enable/disable, rename, color label, link/unlink.",
    {
      action: z.enum(["move", "move_to_track", "trim", "set", "link", "unlink"]),
      sequence: seqArg,
      clips: clipSelector,
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
    },
    ANN.write,
    (a) => {
      switch (a.action) {
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
    },
  );

  tool(
    "remove_clips",
    "Remove clips",
    "Delete timeline clips (lift, or ripple to close the gap).",
    { sequence: seqArg, clips: clipSelector, ripple: z.boolean().optional() },
    ANN.destructive,
    (a) => call("remove_clips", a),
  );

  tool(
    "razor",
    "Razor cut",
    "Cut at one or many times, on all tracks or on given tracks. cuts counts the clips really split; times where no clip spans the cut (e.g. past the end of the sequence) are returned in skipped with a warning.",
    { sequence: seqArg, times: z.array(z.number()).min(1), tracks: z.array(z.string()).optional() },
    ANN.write,
    (a) => call("razor", a),
  );

  tool(
    "set_clip_speed",
    "Clip speed",
    "Change clip speed / reverse (QE). Speed 2 = 200%: the clip keeps its media range and its timeline length becomes duration/speed (ripple optional). Linked clips (the audio of a video clip) get the same speed and reverse, so they stay in sync. Works on razored pieces, including ones that end at the end of the media; the result is re-read from Premiere (speed, start/end, media in/out) and lists the linked clips changed.",
    {
      sequence: seqArg,
      clips: clipSelector,
      speed: z.number().positive(),
      reverse: z.boolean().optional(),
      ripple: z.boolean().optional(),
      maintain_pitch: z.boolean().optional(),
      include_linked: z.boolean().optional().describe("Also change linked clips (default true)"),
    },
    ANN.write,
    (a) => call("set_speed", a),
  );

  tool(
    "close_gaps",
    "Close gaps",
    "Ripple clips on given tracks left so no gaps remain (from an optional time).",
    { sequence: seqArg, tracks: z.array(z.string()), from: z.number().optional() },
    ANN.write,
    (a) => call("close_gaps", a),
  );

  tool(
    "select_clips",
    "Select clips",
    "Select clips in the timeline (e.g. to prepare for an interactive action) or read the current selection.",
    { sequence: seqArg, clips: clipSelector.optional(), read_only: z.boolean().optional().describe("Just return the current selection"), deselect_others: z.boolean().optional() },
    ANN.write,
    (a) => (a.read_only ? call("get_selection", a) : call("select_clips", a)),
  );

  // ======================================================== effects
  tool(
    "list_available_effects",
    "Available effects",
    "List effect / transition names exactly as this (possibly localized) Premiere knows them.",
    { kind: z.enum(["video", "audio", "video_transition", "audio_transition"]).optional(), filter: z.string().optional().describe("Regex") },
    ANN.read,
    (a) => call("list_available_effects", a),
  );

  tool(
    "get_clip_effects",
    "Clip effects",
    "Components on clips with every property value and keyframes (times relative to clip start).",
    { sequence: seqArg, clips: clipSelector, include_values: z.boolean().optional(), limit: z.number().int().optional() },
    ANN.read,
    (a) => call("get_clip_effects", a),
  );

  tool(
    "apply_effects",
    "Apply effects",
    "Add effects to many clips at once, optionally setting parameters. English names work on localized Premiere (Gaussian Blur -> Desfoque gaussiano). Note: on Premiere 26 'Gaussian Blur' is the new GPU blur (match name AE.Impact_Blur_FX, strength param 'Amount'; 'Blurriness' is accepted as an alias); use 'Gaussian Blur (Legacy)' for the classic one. The result reports the real component name and match name.",
    {
      sequence: seqArg,
      clips: clipSelector,
      effects: z.array(z.union([z.string(), z.object({ name: z.string(), params: z.record(z.string(), value).optional() })])).min(1),
    },
    ANN.write,
    (a) => call("apply_effects", a, 120000),
  );

  tool(
    "remove_effects",
    "Remove effects",
    "Remove named effects (or all non-intrinsic effects) from clips.",
    { sequence: seqArg, clips: clipSelector, effects: z.array(z.string()).optional().describe("Omit to remove all added effects") },
    ANN.destructive,
    (a) => call("remove_effects", a),
  );

  tool(
    "set_properties",
    "Set effect properties",
    "Set any effect parameter on many clips (static, or a single key with time). Colors accept '#RRGGBB'. Position arrays accept unit 'px'.",
    {
      sequence: seqArg,
      clips: clipSelector,
      set: z
        .array(z.object({ effect: z.string().optional(), property: z.string(), value, time: z.number().optional(), unit: z.enum(["px", "norm"]).optional() }))
        .min(1),
    },
    ANN.write,
    (a) => call("set_properties", a),
  );

  tool(
    "set_transform",
    "Transform clips",
    "Friendly Motion/Opacity setter: scale %, position in pixels, rotation, anchor, opacity %, crop %.",
    { sequence: seqArg, clips: clipSelector, ...transform.shape, blend_mode: z.number().int().optional() },
    ANN.write,
    (a) => call("set_transform", a),
  );

  tool(
    "add_keyframes",
    "Keyframes",
    "Animate properties on many clips. Times are seconds from each clip's start (or 'end'); handles in-point and speed offsets automatically — e.g. a 100%→106% zoom across every clip in one call.",
    { sequence: seqArg, clips: clipSelector, animations: z.array(animation).min(1) },
    ANN.write,
    (a) => call("add_keyframes", a, 120000),
  );

  tool(
    "remove_keyframes",
    "Remove keyframes",
    "Remove all keyframes of a property (keeps the current value), or only within a clip-relative time range.",
    { sequence: seqArg, clips: clipSelector, effect: z.string().optional(), property: z.string(), from: z.number().optional(), to: z.number().optional() },
    ANN.destructive,
    (a) => call("remove_keyframes", a),
  );

  tool(
    "copy_effects",
    "Copy effects",
    "Paste-attributes: copy effects, Motion/Opacity values and keyframes from one clip to others. keyframe_mode 'stretch' rescales key times to each target's length.",
    { sequence: seqArg, from: z.string().describe("Source clip id"), to: clipSelector, include_motion: z.boolean().optional(), keyframe_mode: z.enum(["relative", "stretch"]).optional() },
    ANN.write,
    (a) => call("copy_effects", a, 120000),
  );

  // ======================================================== presets (new)
  tool(
    "list_effect_presets",
    "Effect presets",
    "List the user's saved Effect Presets (from Premiere's preset file) with their effects. NEW: the original MCP could not use presets at all.",
    { filter: z.string().optional(), details: z.boolean().optional() },
    ANN.read,
    async (a) => {
      const { file, presets } = loadPresets();
      const re = a.filter ? new RegExp(a.filter, "i") : null;
      const list = presets
        .filter((p) => !re || re.test(p.path))
        .map((p) =>
          a.details
            ? { path: p.path, effects: p.effects.map((e) => ({ effect: e.displayName, matchName: e.matchName, anchor: e.anchor, params: e.params.length, animated: e.params.filter((x) => x.keys).length })) }
            : { path: p.path, effects: p.effects.map((e) => e.displayName) },
        );
      return { file, count: list.length, presets: list };
    },
  );

  tool(
    "apply_effect_preset",
    "Apply effect preset",
    "Apply a saved Effect Preset (by name or bin path, e.g. 'CANAL ANIME/personagem scala') to many clips: adds its effects and replays parameter values and keyframes, anchored to clip in/out like Premiere does.",
    {
      sequence: seqArg,
      clips: clipSelector,
      preset: z.string(),
      anchor: z.enum(["preset", "in", "out", "scale"]).optional().describe("Keyframe anchoring; default from the preset"),
    },
    ANN.write,
    async (a) => {
      const { presets } = loadPresets();
      const p = findPreset(presets, a.preset);
      const effects = p.effects.map((e) => ({ ...e, anchor: a.anchor && a.anchor !== "preset" ? a.anchor : e.anchor }));
      const res: any = await call("apply_effect_spec", { sequence: a.sequence, clips: a.clips, effects }, 180000);
      return { preset: p.path, ...res };
    },
  );

  tool(
    "add_transitions",
    "Transitions",
    "Add a video or audio transition at the start/end/both of many clips (default Cross Dissolve / Constant Power).",
    {
      sequence: seqArg,
      clips: clipSelector,
      name: z.string().optional(),
      position: z.enum(["start", "end", "both"]).optional(),
      duration: z.number().optional().describe("Seconds, default 0.5"),
      alignment: z.enum(["center", "start", "end"]).optional(),
      single_sided: z.boolean().optional(),
    },
    ANN.write,
    (a) => call("add_transitions", a, 120000),
  );

  // ======================================================== audio
  tool(
    "set_volume",
    "Clip volume",
    "Set audio clip level in dB, or a dB envelope with keys [{t, db}] (ducking).",
    { sequence: seqArg, clips: clipSelector, db: z.number().optional(), keys: z.array(z.object({ t: z.number(), db: z.number() })).optional() },
    ANN.write,
    (a) => call("set_volume", a),
  );

  tool(
    "fade_audio",
    "Audio fades",
    "Fade audio clips in/out with volume keyframes (language-independent).",
    { sequence: seqArg, clips: clipSelector, fade_in: z.number().optional(), fade_out: z.number().optional(), level_db: z.number().optional() },
    ANN.write,
    (a) => call("fade_audio", a),
  );

  // ======================================================== markers / playhead
  tool(
    "markers",
    "Markers",
    "List, add (batch) or delete sequence markers, or clip markers of a project item.",
    {
      action: z.enum(["list", "add", "delete"]),
      sequence: seqArg,
      item: z.string().optional().describe("Use the project item's clip markers instead"),
      markers: z
        .array(z.object({ time: z.number(), name: z.string().optional(), comment: z.string().optional(), duration: z.number().optional(), color: z.number().int().min(0).max(7).optional(), type: z.enum(["comment", "chapter", "segmentation", "web"]).optional(), url: z.string().optional() }))
        .optional(),
      time: z.number().optional(),
      name_regex: z.string().optional(),
      from: z.number().optional(),
      to: z.number().optional(),
    },
    ANN.write,
    (a) => call(a.action === "list" ? "list_markers" : a.action === "add" ? "add_markers" : "delete_markers", a),
  );

  tool("playhead", "Playhead", "Get or set the playhead position (seconds).", { sequence: seqArg, seconds: z.number().optional() }, ANN.write, (a) =>
    a.seconds === undefined ? call("get_playhead", a) : call("set_playhead", a),
  );

  // ======================================================== export
  tool(
    "export_frames",
    "Export frames",
    "Render sequence frames at given times and SHOW them (the images come back to the assistant), optionally as one labeled contact sheet. Use to visually verify edits. Files are also saved to disk.",
    {
      sequence: seqArg,
      times: z.array(z.number()).min(1).max(48),
      folder: z.string().optional().describe("Where to keep PNGs; default temp"),
      contact_sheet: z.boolean().optional().describe("Default true when more than 2 frames"),
      columns: z.number().int().optional(),
      preview_width: z.number().int().optional().describe("Returned image width, default 960"),
      return_images: z.boolean().optional().describe("Default true"),
    },
    ANN.read,
    async (a) => {
      const folder = path.resolve(a.folder || scratch);
      ensureOutputDir(folder);
      const pngPreset = media.findExportPresets("PNG Sequence \(Match Source\)").find((p) => !/Alpha/i.test(p.name) && /Premiere/i.test(p.path))?.path || media.findExportPresets("PNG").find((p) => !/Alpha/i.test(p.name))?.path;
      const res: any = await call("export_frame", { sequence: a.sequence, times: a.times, folder, png_preset: pngPreset }, 60000 + a.times.length * 15000);
      const frames = res.frames as { time: number; timecode: string; path: string | null }[];
      const ok = frames.filter((f) => f.path);
      const content: Content[] = [];
      const sheet = a.contact_sheet ?? ok.length > 2;
      if (a.return_images !== false && ok.length) {
        if (sheet) {
          const out = path.join(folder, `sheet_${Date.now()}.jpg`);
          await media.contactSheet(ok.map((f) => ({ path: f.path!, label: `${f.time.toFixed(2)}s  ${f.timecode}` })), out, a.columns || (ok.length <= 4 ? 2 : 3), 480);
          content.push({ type: "image", data: await media.toPreviewJpeg(out, a.preview_width || 1440), mimeType: "image/jpeg" });
          (res as any).sheet = out;
        } else {
          for (const f of ok) content.push({ type: "image", data: await media.toPreviewJpeg(f.path!, a.preview_width || 960), mimeType: "image/jpeg" });
        }
      }
      content.unshift({ type: "text", text: compact({ frames, sheet: res.sheet, failed: frames.length - ok.length, errors: res.errors, hint: res.hint }) });
      if (!ok.length) return { isError: true, content: [{ type: "text", text: compact({ error: "No frame could be rendered.", code: "FRAME_EXPORT_FAILED", hint: res.hint, details: res.errors }) }] } as ToolResult;
      return { content, _meta: { "premiere-mcp-plus/summary": `${ok.length}/${frames.length} frames exportados` } } as ToolResult;
    },
  );

  tool(
    "list_export_presets",
    "Export presets",
    "Find .epr export presets installed with Premiere / Media Encoder (filter by regex, e.g. 'H.264|Match Source').",
    { filter: z.string().optional() },
    ANN.read,
    async (a) => {
      const list = media.findExportPresets(a.filter);
      return { count: list.length, presets: list.slice(0, 80) };
    },
  );

  tool(
    "export_sequence",
    "Export sequence",
    "Render the sequence to a file using an .epr preset — directly in Premiere (blocks until done) or queued in Adobe Media Encoder. Range: entire / in_out / work_area. Media Encoder reads the saved project, so the project is saved before queueing; pass wait: true to block until AME has written the file.",
    {
      sequence: seqArg,
      output: z.string(),
      preset_path: z.string().optional().describe("Default: first 'Match Source - Adaptive High Bitrate' / H.264 preset found"),
      range: z.enum(["entire", "in_out", "work_area"]).optional(),
      use_media_encoder: z.boolean().optional(),
      wait: z.boolean().optional().describe("use_media_encoder: wait until the file exists and is a valid media file (default false)"),
      wait_timeout_s: z.number().optional().describe("Export timeout (direct, or AME with wait), default 1800"),
    },
    ANN.write,
    async (a) => {
      let preset = a.preset_path;
      if (!preset) {
        const list = media.findExportPresets("Match Source.*(High|Adaptive)|H\\.264");
        // Prefer Premiere's H.264 (.mp4) "Match Source - Adaptive High Bitrate";
        // AME's "H264 Match Source" preset writes QuickTime .mov.
        const rank = (p: { name: string; source: string }) =>
          (/^Match Source - Adaptive High Bitrate$/i.test(p.name) ? 0 : /^Match Source - High bitrate$/i.test(p.name) ? 1 : /Match Source/i.test(p.name) ? 2 : 3) * 2 + (p.source === "Premiere" ? 0 : 1);
        preset = [...list].sort((x, y) => rank(x) - rank(y))[0]?.path;
        if (!preset) throw new Error("No export preset found; pass preset_path (see list_export_presets).");
      }
      // Transparent still used to pad a range that ends in a gap (see host export_media).
      const filler = path.join(bridge.dir, "mcp-filler.png");
      if (!fs.existsSync(filler)) await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(filler);
      ensureOutputDir(path.dirname(path.resolve(a.output)));
      const out = path.resolve(a.output);
      const timeout = (a.wait_timeout_s || 1800) * 1000;
      const run = () => call("export_media", { sequence: a.sequence, path: out, preset_path: preset, range: a.range, use_media_encoder: a.use_media_encoder, filler_path: filler, keep_temp: true }, timeout) as Promise<any>;
      const startedAt = Date.now() - 2000;
      let res = await run();
      // The host renames the output to the preset's real extension (.mov...).
      const actual: string = res.path || out;
      if (res.queued) {
        if (!a.wait) return res;
        // Wait for AME: a new (or rewritten) file that ffprobe can read.
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          if (fs.existsSync(actual) && fs.statSync(actual).mtimeMs > startedAt) {
            const check = await media.waitForValidMedia(actual, Math.max(5_000, end - Date.now()));
            if (check.valid) return { ...res, done: true, bytes: fs.statSync(actual).size, duration: check.duration };
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new BridgeError("AME_TIMEOUT", `Media Encoder job ${res.jobId} did not produce ${actual} within ${Math.round(timeout / 1000)}s.`, "Check the Media Encoder queue for errors.");
      }
      // Premiere can return before the file is finalized: wait until it is a valid media file.
      let check = await media.waitForValidMedia(actual, 120_000);
      if (!check.valid) {
        if (res.tempSequence) await call("delete_sequence", { sequence: res.tempSequence }).catch(() => undefined);
        res = await run(); // one retry
        check = await media.waitForValidMedia(actual, 180_000);
      }
      if (res.tempSequence) {
        await call("delete_sequence", { sequence: res.tempSequence }).catch(() => undefined);
        delete res.tempSequence;
      }
      if (!check.valid) throw new Error(`Premiere wrote an incomplete file (${check.reason}). Keep the Premiere window visible and retry, or use use_media_encoder: true.`);
      return { ...res, bytes: fs.statSync(actual).size, duration: check.duration };
    },
  );

  tool(
    "export_interchange",
    "Export XML / EDL / AAF",
    "Export the sequence as Final Cut Pro XML (no 'Translation Report' dialog), CMX3600 EDL, or AAF. Missing folders are created. When Premiere has no EDL exporter (26.x), the EDL is generated from the timeline (video_track + audio_tracks).",
    {
      sequence: seqArg,
      format: z.enum(["fcp_xml", "edl", "aaf"]),
      path: z.string(),
      video_track: track.optional().describe("EDL: video track to list (default V1)"),
      audio_tracks: z.array(z.string()).optional().describe('EDL: audio tracks (default ["A1","A2"])'),
    },
    ANN.write,
    async (a) => {
      const p = path.resolve(a.path);
      ensureOutputDir(path.dirname(p));
      if (a.format === "fcp_xml") return call("export_fcp_xml", { sequence: a.sequence, path: p }, 120000);
      if (a.format === "edl") {
        const r: any = await call("export_edl", { sequence: a.sequence, path: p }, 120000);
        if (r.nativeExport) return { path: p, generator: "premiere" };
        const tl: any = await call("get_timeline", { sequence: a.sequence, include_effects: false });
        const edl = buildEdl(tl, { videoTrack: a.video_track, audioTracks: a.audio_tracks });
        fs.writeFileSync(p, edl.text, "utf-8");
        return { path: p, generator: "premiere-mcp-plus (CMX3600 from timeline)", events: edl.events, bytes: fs.statSync(p).size };
      }
      return call("export_aaf", { sequence: a.sequence, path: p }, 600000);
    },
  );

  // ======================================================== text / graphics
  tool(
    "create_title_image",
    "Title image",
    "Render a transparent PNG title with any .ttf/.otf font (e.g. Bebas Neue), fill, outline, underline and shadow; optionally import and place it on the timeline in the same call.",
    {
      output: z.string().describe("PNG path"),
      lines: z
        .array(
          z.object({
            text: z.string(),
            size: z.number().optional(),
            color: z.string().optional(),
            stroke_color: z.string().optional(),
            stroke_width: z.number().optional(),
            letter_spacing: z.number().optional(),
            underline: z.object({ color: z.string().optional(), thickness: z.number().optional(), offset: z.number().optional() }).optional(),
          }),
        )
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
      place: z.object({ sequence: seqArg, track: track.optional(), start: z.number(), duration: z.number().optional(), bin: z.string().optional() }).optional(),
      preview: z.boolean().optional().describe("Return the image (default true)"),
    },
    ANN.write,
    async (a) => {
      const r = renderTitle({ ...a, output: path.resolve(a.output) } as any);
      const out: any = { title: r };
      if (a.place) {
        const imp: any = await call("import_files", { paths: [r.path], bin: a.place.bin || "_MCP Plus/Titles" });
        const id = imp.imported[0]?.id;
        if (!id) throw new Error("Title was rendered but not imported.");
        out.placed = await call("place_clips", { sequence: a.place.sequence, clips: [{ item: id, track: a.place.track || "V2", start: a.place.start, duration: a.place.duration ?? 3 }] });
      }
      const content: Content[] = [{ type: "text", text: compact(out) }];
      if (a.preview !== false) content.push({ type: "image", data: await media.toPreviewJpeg(r.path, 640), mimeType: "image/jpeg" });
      return { content } as ToolResult;
    },
  );

  tool(
    "mogrt",
    "Motion Graphics Templates",
    "Import a .mogrt onto the timeline (with text/params filled in), read its editable params, or set params (text, colors, numbers) on existing MOGRT clips.",
    {
      action: z.enum(["import", "get_params", "set_params"]),
      sequence: seqArg,
      path: z.string().optional(),
      track: track.optional(),
      start: z.number().optional(),
      duration: z.number().optional(),
      clips: clipSelector.optional(),
      params: z.record(z.string(), value).optional().describe('e.g. {"Text": "Hello", "Color": "#46C8FF"}'),
    },
    ANN.write,
    (a) => {
      if (a.action === "import") return call("import_mogrt", { ...a, path: a.path ? path.resolve(a.path) : undefined }, 120000);
      if (a.action === "get_params") return call("get_mogrt_params", a);
      return call("set_mogrt_params", a);
    },
  );

  tool(
    "import_captions",
    "Import captions",
    "Import an .srt/.scc/.vtt file and create a caption track on the sequence.",
    { sequence: seqArg, path: z.string(), start: z.number().optional(), format: z.enum(["subtitle", "open", "608", "708"]).optional() },
    ANN.write,
    (a) => call("import_captions", { ...a, path: path.resolve(a.path) }, 120000),
  );

  // ======================================================== analysis (local ffmpeg)
  tool(
    "analyze_media",
    "Analyze media",
    "Analyze a media file locally with FFmpeg (no Premiere needed): probe streams, detect silences (for jump cuts), detect scene cuts, measure loudness (LUFS), or grab source frames as images.",
    {
      action: z.enum(["probe", "silence", "scenes", "loudness", "frames"]),
      file: z.string(),
      noise_db: z.number().optional(),
      min_silence: z.number().optional(),
      threshold: z.number().optional().describe("Scene threshold 0-1, default 0.3"),
      times: z.array(z.number()).optional().describe("frames: source times"),
    },
    ANN.read,
    async (a) => {
      const f = path.resolve(a.file);
      if (!fs.existsSync(f)) throw new BridgeError("FILE_NOT_FOUND", `File not found: ${f}`, "Check the path (absolute paths are safest).");
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
          return { content: [{ type: "text", text: compact({ frames: files, sheet }) }, { type: "image", data: await media.toPreviewJpeg(sheet, 1440), mimeType: "image/jpeg" }] } as ToolResult;
        }
      }
    },
  );

  // ======================================================== power tools
  tool(
    "run_extendscript",
    "Run ExtendScript",
    "Escape hatch: run ExtendScript in Premiere. The code is a function body; use `return` to send back a JSON-serializable value. `H` exposes every host handler and `helpers` has getSequence/selectClips/resolveItem/tsec. The language is ES3: no let/const, arrow functions, template strings, Array.map/forEach or JSON object. Reserved words cannot be literal keys: `{in: 1}` fails with \"Illegal use of reserved word 'in'\"; write `o[\"in\"] = 1` (same for class, default, new...).",
    { code: z.string() },
    ANN.destructive,
    (a) => call("eval_script", a, 120000),
  );

  tool(
    "batch",
    "Batch operations",
    "Run several host operations in a single Premiere round trip, in order (stops at first error unless continue_on_error). Op names are host handler names, e.g. place_clips, set_transform, add_keyframes, apply_effects, razor, add_markers, set_track.",
    { ops: z.array(z.object({ fn: z.string(), args: z.record(z.string(), z.any()).optional() })).min(1), continue_on_error: z.boolean().optional() },
    ANN.write,
    (a) => call("batch", a, 300000),
  );

  tool(
    "undo",
    "Undo / redo",
    "Undo whole tool calls with calls: N (recommended): one tool call can push several Premiere undo steps (set_clip_speed does), and DOM edits like trims and moves never reach Premiere's undo stack, so the server records both per call and rewinds them together. steps: N is Premiere's raw undo (Ctrl+Z) N times. history: true lists the recorded calls. Undoing by calls stops with UNDO_STACK_CHANGED if the project was edited by hand since.",
    {
      calls: z.number().int().min(1).max(50).optional().describe("Undo the last N tool calls"),
      steps: z.number().int().min(1).max(50).optional().describe("Raw Premiere undo steps"),
      redo: z.boolean().optional().describe("Redo raw steps"),
      history: z.boolean().optional().describe("List the recorded calls instead of undoing"),
    },
    ANN.write,
    (a) => {
      if (a.history) return call("undo_history", {});
      if (a.redo) return call("redo", a);
      if (a.calls === undefined && a.steps === undefined) return call("undo", { calls: 1 });
      return call("undo", a);
    },
  );
}
