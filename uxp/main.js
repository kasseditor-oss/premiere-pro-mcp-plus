/* Premiere MCP Plus - UXP connector (loader).
 *
 * Every MCP server process registers itself in <temp>/premiere-mcp-plus/uxp-servers/<pid>.json
 * ({port, token}). This loader connects to each of them over WebSocket (127.0.0.1 only, token
 * in the URL), so several MCP clients (Claude Desktop, Claude Code...) can use UXP at once.
 * On connect the server sends the handler code ({type:"code"}); calls are {id, fn, args} and
 * answers {id, ok, data | error}. Handlers live on the server, so updating them never needs a
 * Premiere restart; only this loader is installed in Premiere.
 */
const ppro = require("premierepro");
const uxp = require("uxp");
const fsys = uxp.storage.localFileSystem;

function log(msg) {
  try {
    const el = document.getElementById("log");
    el.textContent = (new Date().toLocaleTimeString() + " " + msg + "\n" + el.textContent).slice(0, 4000);
  } catch (e) {}
}
function setStatus(t) { try { document.getElementById("s").textContent = t; } catch (e) {} }

function candidateDirs() {
  const out = [];
  try { const os = require("os"); if (os.tmpdir) out.push(os.tmpdir()); if (os.homedir) { out.push(os.homedir() + "\\AppData\\Local\\Temp"); out.push(os.homedir() + "/Library/Caches/TemporaryItems"); } } catch (e) {}
  return out;
}
const fileUrl = (p) => "file:" + (p.replace(/\\/g, "/").startsWith("/") ? "" : "/") + p.replace(/\\/g, "/");

async function registry() {
  const found = [];
  for (const d of candidateDirs()) {
    try {
      const folder = await fsys.getEntryWithUrl(fileUrl(d + "/premiere-mcp-plus/uxp-servers"));
      const entries = await folder.getEntries();
      for (const e of entries) {
        if (!/\.json$/.test(e.name)) continue;
        try { found.push(JSON.parse(await e.read())); } catch (er) {}
      }
      // legacy single-server file
      try { const f = await fsys.getEntryWithUrl(fileUrl(d + "/premiere-mcp-plus/uxp.json")); found.push(JSON.parse(await f.read())); } catch (er2) {}
      if (found.length) break;
    } catch (e) {}
  }
  return found;
}

const conns = new Map(); // key "port" -> {ws, H}
function connectTo(cfg) {
  const key = String(cfg.port);
  if (conns.has(key)) return;
  let ws;
  try { ws = new WebSocket("ws://127.0.0.1:" + cfg.port + "/uxp?token=" + encodeURIComponent(cfg.token)); } catch (e) { return; }
  const c = { ws, H: {} };
  conns.set(key, c);
  ws.onopen = () => { log("connected :" + cfg.port); update(); };
  ws.onclose = () => { conns.delete(key); log("closed :" + cfg.port); update(); };
  ws.onerror = () => {};
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "code") {
      try {
        c.H = new Function("ppro", "uxp", msg.code)(ppro, uxp) || {};
        ws.send(JSON.stringify({ type: "ready", handlers: Object.keys(c.H), host: (uxp.host && uxp.host.version) || "" }));
      } catch (e) { ws.send(JSON.stringify({ type: "ready", error: String(e) })); }
      return;
    }
    const t0 = Date.now();
    let out;
    try {
      if (!c.H[msg.fn]) throw Object.assign(new Error("Unknown UXP function " + msg.fn), { code: "UNKNOWN_FUNCTION" });
      out = { id: msg.id, ok: true, data: await c.H[msg.fn](msg.args || {}) };
    } catch (e) {
      out = { id: msg.id, ok: false, error: { code: e.code || "UXP_ERROR", message: String((e && e.message) || e) } };
    }
    out.ms = Date.now() - t0;
    try { ws.send(JSON.stringify(out)); } catch (e) {}
  };
}
function update() { setStatus(conns.size ? conns.size + " server(s) connected" : "waiting for MCP servers"); }

async function scan() {
  try { for (const cfg of await registry()) connectTo(cfg); } catch (e) {}
  update();
  setTimeout(scan, 3000);
}
scan();
