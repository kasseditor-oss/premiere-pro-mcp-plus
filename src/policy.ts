import { createHash, randomBytes } from "node:crypto";
import { BridgeError } from "./bridge.js";

/**
 * Authority: permission profiles decide which tools exist at all, tool packs
 * decide which ones the model sees, confirmation tokens guard big destructive
 * operations.
 *
 *   PREMIERE_MCP_PROFILES  comma list of inspect, edit, export, filesystem, unsafe-script, or "all"
 *                          (default: inspect,edit,export,filesystem; run_extendscript needs unsafe-script)
 *   PREMIERE_MCP_PACK      comma list of essential, editing, audio, color, captions, delivery, full (default full)
 *   PREMIERE_MCP_CONFIRM   "0" turns confirmation tokens off
 */
export type Profile = "inspect" | "edit" | "export" | "filesystem" | "unsafe-script";
export const ALL_PROFILES: Profile[] = ["inspect", "edit", "export", "filesystem", "unsafe-script"];

function list(env: string | undefined): string[] {
  return (env || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function activeProfiles(): Set<Profile> {
  const l = list(process.env.PREMIERE_MCP_PROFILES);
  if (!l.length) return new Set(["inspect", "edit", "export", "filesystem"]);
  if (l.includes("all")) return new Set(ALL_PROFILES);
  return new Set(l.filter((x) => (ALL_PROFILES as string[]).includes(x)) as Profile[]);
}

/** Profile each tool needs (tools not listed need "edit"). */
const NEEDS: Record<string, Profile> = {
  premiere_status: "inspect",
  bridge_stats: "inspect",
  get_project: "inspect",
  list_project_items: "inspect",
  get_item_info: "inspect",
  list_sequences: "inspect",
  get_timeline: "inspect",
  find_clips: "inspect",
  list_available_effects: "inspect",
  get_clip_effects: "inspect",
  list_effect_presets: "inspect",
  list_export_presets: "inspect",
  analyze_media: "inspect",
  inspect: "inspect",
  search_items: "inspect",
  jobs: "inspect",
  scopes: "inspect",
  export_frames: "export",
  export_sequence: "export",
  export_interchange: "export",
  deliver: "export",
  encode: "export",
  review: "export",
  create_title_image: "filesystem",
  transcribe: "filesystem",
  run_extendscript: "unsafe-script",
};
export function profileFor(tool: string): Profile {
  return NEEDS[tool] || "edit";
}

const PACKS: Record<string, string[]> = {
  essential: [
    "premiere_status", "get_project", "get_timeline", "list_project_items", "import_media", "create_sequence", "place_clips",
    "edit_clips", "remove_clips", "razor", "set_transform", "apply_effects", "add_keyframes", "markers", "playhead",
    "export_frames", "export_sequence", "undo", "batch", "jobs",
  ],
  editing: [
    "inspect", "find_clips", "open_sequence", "set_volume", "manage_sequence", "sequence_tools", "manage_tracks", "set_clip_speed", "close_gaps", "select_clips", "ripple_delete_ranges", "source", "checkpoint",
    "copy_effects", "remove_effects", "set_properties", "keyframe_tools", "remove_keyframes", "add_transitions", "apply_effect_preset", "list_effect_presets",
    "list_available_effects", "get_clip_effects", "auto_edit", "recipes", "manage_bins", "manage_project_items", "search_items", "metadata",
  ],
  audio: ["audio", "fade_audio", "set_volume", "find_clips", "analyze_media", "transcribe", "auto_edit"],
  color: ["color", "scopes", "set_properties", "get_clip_effects", "apply_effects", "remove_effects", "list_available_effects", "adjustment_layer"],
  captions: ["captions", "transcribe", "import_captions", "create_title_image", "mogrt"],
  delivery: ["export_interchange", "list_export_presets", "deliver", "encode", "review", "project_file", "project_tools", "media"],
};

/** Tool names the active packs show, or null for all. */
export function packTools(): Set<string> | null {
  const l = list(process.env.PREMIERE_MCP_PACK);
  if (!l.length || l.includes("full")) return null;
  const out = new Set<string>(PACKS.essential);
  for (const p of l) for (const t of PACKS[p] || []) out.add(t);
  return out;
}

// ---------------------------------------------------------------- confirmation tokens
const tokens = new Map<string, { hash: string; tool: string; expires: number }>();
const TOKEN_TTL_MS = 5 * 60 * 1000;

export function confirmationsOn(): boolean {
  return process.env.PREMIERE_MCP_CONFIRM !== "0";
}

/** JSON with object keys sorted at every level (stable for hashing). */
function stable(v: any): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}

function argsHash(tool: string, args: any): string {
  const { confirm_token: _t, ...rest } = args || {};
  return createHash("sha256").update(tool + stable(rest)).digest("hex");
}

/** Issue a one-time token for exactly these arguments. */
export function issueToken(tool: string, args: any): string {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k);
  const t = randomBytes(6).toString("hex");
  tokens.set(t, { hash: argsHash(tool, args), tool, expires: now + TOKEN_TTL_MS });
  return t;
}

/** Consume a token; throws when it is unknown, expired, or was issued for other arguments. */
export function consumeToken(tool: string, args: any): void {
  const t = String(args?.confirm_token || "");
  const rec = tokens.get(t);
  if (!rec || rec.expires < Date.now()) {
    tokens.delete(t);
    throw new BridgeError("CONFIRMATION_INVALID", "The confirmation token is unknown or expired (tokens are single-use and last 5 minutes).", "Call the tool again without confirm_token to get a fresh preview and token.");
  }
  if (rec.tool !== tool || rec.hash !== argsHash(tool, args)) {
    throw new BridgeError("CONFIRMATION_MISMATCH", "The confirmation token was issued for different arguments.", "Repeat the exact arguments of the preview call, plus confirm_token.");
  }
  tokens.delete(t);
}
