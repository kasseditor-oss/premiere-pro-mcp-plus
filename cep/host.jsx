// Premiere MCP Plus - host loader. The real library is loaded on demand by the
// panel from the MCP server's bridge directory (so server upgrades never need
// an extension reinstall).
function mcpPlusLoad(path) {
  var f = new File(path);
  if (!f.exists) return "missing:" + path;
  try { return String($.evalFile(f)); } catch (e) { return "error:" + e.toString() + " line " + e.line; }
}
function mcpPlusVersion() {
  return (typeof $.__mcpPlus !== "undefined" && $.__mcpPlus) ? String($.__mcpPlus.version) : "";
}
