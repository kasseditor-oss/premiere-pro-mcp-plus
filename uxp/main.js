/* Premiere MCP Plus - UXP connector.
 *
 * Connects to the MCP server's WebSocket (127.0.0.1 only) and answers calls
 * {id, fn, args} with {id, ok, data | error}. The port and the auth token are
 * read from <temp>/premiere-mcp-plus/uxp.json, written by the server.
 * Every handler is a thin wrapper over the premierepro UXP API; the server
 * asks for `probe` first and only routes an action here when the probe says
 * the API it needs exists.
 */
const ppro = require("premierepro");
const uxp = require("uxp");
const fsys = uxp.storage.localFileSystem;

const statusEl = () => document.getElementById("s");
function log(msg) {
  try {
    const el = document.getElementById("log");
    el.textContent = (new Date().toLocaleTimeString() + " " + msg + "\n" + el.textContent).slice(0, 4000);
  } catch (e) {}
}
function setStatus(t) { try { statusEl().textContent = t; } catch (e) {} }

function candidateDirs() {
  const out = [];
  try { const os = require("os"); if (os.tmpdir) out.push(os.tmpdir()); if (os.homedir) out.push(os.homedir() + "\\AppData\\Local\\Temp"); } catch (e) {}
  try { const os = require("os"); if (os.homedir) out.push(os.homedir() + "/Library/Caches/TemporaryItems"); } catch (e) {}
  return out;
}

async function readConfig() {
  for (const d of candidateDirs()) {
    const p = d.replace(/\\/g, "/") + "/premiere-mcp-plus/uxp.json";
    try {
      const entry = await fsys.getEntryWithUrl("file:" + (p.startsWith("/") ? "" : "/") + p);
      const txt = await entry.read();
      const cfg = JSON.parse(txt);
      cfg.dir = d;
      return cfg;
    } catch (e) {}
  }
  return null;
}

// ---------------------------------------------------------------- helpers
const TPS = 254016000000;
const sec = (t) => (t && t.seconds !== undefined ? t.seconds : t && t.ticks !== undefined ? Number(t.ticks) / TPS : Number(t));
const tt = (s) => ppro.TickTime.createWithSeconds(Number(s));

async function project() {
  const p = await ppro.Project.getActiveProject();
  if (!p) throw Object.assign(new Error("No project is open."), { code: "NO_PROJECT" });
  return p;
}
async function sequence(p, ref) {
  if (!ref) {
    const s = await p.getActiveSequence();
    if (!s) throw Object.assign(new Error("No active sequence."), { code: "NO_ACTIVE_SEQUENCE" });
    return s;
  }
  const list = await p.getSequences();
  for (const s of list) {
    let id = "";
    try { id = s.guid ? s.guid.toString() : ""; } catch (e) {}
    if (id === ref || s.name === ref) return s;
  }
  for (const s of list) if (String(s.name).toLowerCase() === String(ref).toLowerCase()) return s;
  throw Object.assign(new Error("Sequence not found: " + ref), { code: "SEQUENCE_NOT_FOUND" });
}
// Run actions inside one undoable transaction (a real Premiere undo step).
async function transact(p, label, build) {
  let ok = false;
  await p.lockedAccess(() => {
    ok = p.executeTransaction((compound) => {
      const actions = build();
      for (const a of actions) compound.addAction(a);
    }, label);
  });
  return ok;
}

function surface() {
  // Names of the API classes and their static/instance methods, for the capability probe.
  const out = {};
  for (const k of Object.keys(ppro)) {
    const v = ppro[k];
    if (typeof v !== "function" && typeof v !== "object") continue;
    const names = new Set();
    try { for (const n of Object.getOwnPropertyNames(v)) if (!/^(length|name|prototype|caller|arguments)$/.test(n)) names.add(n); } catch (e) {}
    try { if (v.prototype) for (const n of Object.getOwnPropertyNames(v.prototype)) if (n !== "constructor") names.add("#" + n); } catch (e) {}
    out[k] = Array.from(names);
  }
  return out;
}

// ---------------------------------------------------------------- handlers
const H = {
  async probe() {
    let version = "";
    try { version = uxp.host.version; } catch (e) {}
    return { uxp: true, host: (uxp.host && uxp.host.name) || "premierepro", version, api: surface() };
  },
  async state() {
    const p = await project();
    const s = await p.getActiveSequence();
    const out = { project: { name: p.name, path: p.path } };
    if (s) {
      const pos = await s.getPlayerPosition();
      out.sequence = { name: s.name, playhead: sec(pos) };
    }
    return out;
  },
  async set_playhead(a) {
    const p = await project();
    const s = await sequence(p, a.sequence);
    await s.setPlayerPosition(tt(a.seconds));
    return { playhead: sec(await s.getPlayerPosition()) };
  },
  async get_playhead(a) {
    const p = await project();
    const s = await sequence(p, a.sequence);
    return { playhead: sec(await s.getPlayerPosition()) };
  },
  // Escape hatch (unsafe-script profile only, enforced by the server).
  async js(a) {
    const f = new Function("ppro", "uxp", "args", "return (async () => {" + a.code + "})();");
    const r = await f(ppro, uxp, a.args || {});
    return { result: r === undefined ? null : r };
  },
};

// ---------------------------------------------------------------- connection
let ws = null, cfg = null, served = 0;
async function connect() {
  cfg = await readConfig();
  if (!cfg) { setStatus("waiting for the MCP server"); return setTimeout(connect, 3000); }
  try {
    ws = new WebSocket("ws://127.0.0.1:" + cfg.port + "/uxp?token=" + encodeURIComponent(cfg.token));
  } catch (e) { log("connect failed: " + e); return setTimeout(connect, 3000); }
  ws.onopen = () => { setStatus("connected :" + cfg.port); log("connected"); };
  ws.onclose = () => { setStatus("disconnected"); ws = null; setTimeout(connect, 2000); };
  ws.onerror = () => {};
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    const t0 = Date.now();
    let out;
    try {
      if (!H[msg.fn]) throw Object.assign(new Error("Unknown UXP function " + msg.fn), { code: "UNKNOWN_FUNCTION" });
      out = { id: msg.id, ok: true, data: await H[msg.fn](msg.args || {}) };
    } catch (e) {
      out = { id: msg.id, ok: false, error: { code: e.code || "UXP_ERROR", message: String((e && e.message) || e) } };
    }
    out.ms = Date.now() - t0;
    served++;
    try { ws.send(JSON.stringify(out)); } catch (e) {}
    log((out.ok ? "ok " : "err ") + msg.fn + " " + out.ms + "ms");
  };
}
connect();
