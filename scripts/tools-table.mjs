// Print the README table of tools and actions from the live tools/list.
// Usage: node scripts/tools-table.mjs > docs/TOOLS.md
import { connect } from "../tests/mcp-client.mjs";
const c = await connect({ PREMIERE_MCP_UXP: "0" });
const { tools } = (await c.req("tools/list", {})).result;
const AREA = {
  "Status e projeto": ["premiere_status", "bridge_stats", "jobs", "checkpoint", "get_project", "project_file", "project_tools", "list_project_items", "search_items", "get_item_info", "import_media", "replace_media", "manage_bins", "manage_project_items", "media", "metadata", "inspect"],
  "Sequências e trilhas": ["list_sequences", "open_sequence", "create_sequence", "manage_sequence", "sequence_tools", "manage_tracks"],
  "Timeline": ["get_timeline", "find_clips", "place_clips", "edit_clips", "remove_clips", "ripple_delete_ranges", "razor", "set_clip_speed", "close_gaps", "select_clips", "source", "playhead", "markers"],
  "Efeitos, cor e keyframes": ["list_available_effects", "get_clip_effects", "apply_effects", "remove_effects", "set_properties", "set_transform", "add_keyframes", "remove_keyframes", "keyframe_tools", "copy_effects", "list_effect_presets", "apply_effect_preset", "add_transitions", "color", "stabilize", "adjustment_layer", "scopes", "mask_fit"],
  "Áudio": ["set_volume", "fade_audio", "audio", "analyze_media"],
  "Texto, gráficos e legendas": ["create_title_image", "mogrt", "import_captions", "captions", "transcribe"],
  "Revisão e entrega": ["export_frames", "review", "export_sequence", "list_export_presets", "export_interchange", "deliver", "encode"],
  "Automação": ["auto_edit", "recipes", "batch", "undo", "run_extendscript"],
};
const by = new Map(tools.map((t) => [t.name, t]));
const lines = [`${tools.length} ferramentas. Ações = valores do parâmetro \`action\`.`, ""];
for (const [area, names] of Object.entries(AREA)) {
  lines.push(`### ${area}`, "", "| Ferramenta | Ações / uso |", "|---|---|");
  for (const n of names) {
    const t = by.get(n);
    if (!t) continue;
    by.delete(n);
    const acts = t.inputSchema?.properties?.action?.enum;
    const first = t.description.split(/(?<=\.)\s/)[0];
    lines.push(`| \`${n}\` | ${acts ? acts.map((x) => `\`${x}\``).join(", ") + " — " : ""}${first.replace(/\|/g, "\|")} |`);
  }
  lines.push("");
}
if (by.size) lines.push("Outras: " + [...by.keys()].join(", "));
console.log(lines.join("\n"));
c.close();
