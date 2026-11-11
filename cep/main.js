/* Premiere MCP Plus - CEP bridge.
 *
 * Protocol (directory = %TEMP%/premiere-mcp-plus or PREMIERE_MCP_PLUS_DIR):
 *   server writes  cmd_<id>.json   {id, fn, args, lib:{path, version}}
 *   panel claims   cmd_<id>.json -> cmd_<id>.json.<engine>.claimed  (atomic rename)
 *   panel writes   res_<id>.json   (atomic: .staged then rename)
 *   panel writes   heartbeat.json  every second {state, busy, lib, engine, ts}
 *
 * Improvements over the original bridge: fs.watch wake-ups (no 200 ms polling
 * latency), JSON-RPC calls into a preloaded host library instead of shipping
 * whole scripts, a busy flag inside the heartbeat, and lib hot-reload.
 */
(function () {
  var req = typeof require !== "undefined" ? require : (window.cep_node && window.cep_node.require);
  function reportFatal(e) {
    try {
      var f = req("fs"), p = req("path"), o = req("os");
      var d = p.join(o.tmpdir(), "premiere-mcp-plus");
      f.mkdirSync(d, { recursive: true });
      f.appendFileSync(p.join(d, "panel-error.log"), new Date().toISOString() + " " + (e && e.stack || e) + "\n");
    } catch (e2) {}
  }
  window.addEventListener("error", function (ev) { reportFatal(ev.error || ev.message); });
  window.addEventListener("unhandledrejection", function (ev) { reportFatal(ev.reason); });
  var fs = req("fs"), path = req("path"), os = req("os");
  var proc = req("process");

  var ENGINE = Math.random().toString(36).slice(2, 8);
  var EXT_ID = ""; try { EXT_ID = window.__adobe_cep__.getExtensionId(); } catch (e) {}
  var IS_PANEL = EXT_ID.indexOf("headless") < 0;
  var DIR = (proc.env.PREMIERE_MCP_PLUS_DIR && proc.env.PREMIERE_MCP_PLUS_DIR.trim()) || path.join(os.tmpdir(), "premiere-mcp-plus");
  var HEARTBEAT = path.join(DIR, "heartbeat.json");

  var busy = null, count = 0, loadedLib = "", watcher = null;

  function $(id) { return document.getElementById(id); }
  function log(msg, cls) {
    if (!IS_PANEL) return;
    var el = $("log"), d = document.createElement("div");
    d.className = "l " + (cls || "");
    d.textContent = new Date().toLocaleTimeString() + "  " + msg;
    el.appendChild(d);
    while (el.children.length > 200) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  function status(text, state) {
    if (!IS_PANEL) return;
    $("status").textContent = text;
    $("dot").className = "dot " + (state || "");
  }

  function evalScript(code) {
    return new Promise(function (resolve) {
      window.__adobe_cep__.evalScript(code, function (r) { resolve(r); });
    });
  }
  // A JS string literal that ExtendScript (ES3) can parse: JSON string escapes plus U+2028/2029.
  function lit(s) {
    var LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    // ExtendScript (ES3) treats raw U+2028/2029 as line breaks inside string literals.
    return JSON.stringify(String(s)).split(LS).join("\\" + "u2028").split(PS).join("\\" + "u2029");
  }

  function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }

  function writeAtomic(file, text) {
    var staged = file + "." + ENGINE + ".staged";
    fs.writeFileSync(staged, text, "utf-8");
    fs.renameSync(staged, file);
  }

  function heartbeat() {
    try {
      writeAtomic(HEARTBEAT, JSON.stringify({ protocol: 2, state: "running", busy: busy, lib: loadedLib, engine: ENGINE, panel: IS_PANEL, ts: Date.now(), count: count }));
    } catch (e) {}
  }

  async function ensureLib(lib) {
    if (!lib || !lib.version) return true;
    if (loadedLib === lib.version) return true;
    var current = await evalScript("mcpPlusVersion()");
    if (current === lib.version) { loadedLib = current; if (IS_PANEL) $("lib").textContent = current.slice(0, 7); return true; }
    var r = await evalScript("mcpPlusLoad(" + lit(lib.path.replace(/\\/g, "/")) + ")");
    log("loaded host library " + lib.version.slice(0, 7) + " → " + r, /^loaded/.test(r) ? "info" : "err");
    current = await evalScript("mcpPlusVersion()");
    loadedLib = current;
    if (IS_PANEL) $("lib").textContent = current ? current.slice(0, 7) : "–";
    return current === lib.version;
  }

  var running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        var files;
        try { files = fs.readdirSync(DIR).filter(function (f) { return /^cmd_[\w-]+\.json$/.test(f); }).sort(); } catch (e) { files = []; }
        if (!files.length) break;
        await runOne(files[0]);
      }
    } finally { running = false; }
  }

  async function runOne(name) {
    var file = path.join(DIR, name);
    var claimed = file + "." + ENGINE + ".claimed";
    try { fs.renameSync(file, claimed); } catch (e) { return; } // other engine won
    var cmd;
    try { cmd = JSON.parse(fs.readFileSync(claimed, "utf-8")); } catch (e) { try { fs.unlinkSync(claimed); } catch (e2) {} return; }
    try { fs.unlinkSync(claimed); } catch (e) {}
    var id = cmd.id, resFile = path.join(DIR, "res_" + id + ".json");
    var started = Date.now();
    busy = { id: id, fn: cmd.fn, since: started };
    heartbeat();
    status("running " + cmd.fn, "busy");
    var out;
    try {
      var libOk = await ensureLib(cmd.lib);
      if (!libOk) {
        out = { ok: false, error: { code: "LIB_LOAD_FAILED", message: "The Premiere host library could not be loaded. Check the panel log (Window > Extensions > Premiere MCP Plus)." } };
      } else {
        var raw = await evalScript("$.__mcpPlus.call(" + lit(cmd.fn) + "," + lit(JSON.stringify(cmd.args || {})) + ")");
        if (raw === undefined || raw === null || raw === "" || raw === "undefined") {
          out = { ok: false, error: { code: "EMPTY_RESULT", message: "Premiere returned no result (ExtendScript engine busy or a modal dialog is open)." } };
        } else if (/^EvalScript error/i.test(raw)) {
          loadedLib = ""; // force a reload next time
          out = { ok: false, error: { code: "EVALSCRIPT_ERROR", message: "Premiere could not run the call (" + raw + "). The host library will be reloaded on the next call." } };
        } else {
          try { out = JSON.parse(raw); } catch (e) { out = { ok: false, error: { code: "BAD_JSON", message: "Host returned non-JSON: " + String(raw).slice(0, 300) } }; }
        }
      }
    } catch (e) {
      out = { ok: false, error: { code: "PANEL_ERROR", message: String(e && e.message || e) } };
    }
    out.bridgeMs = Date.now() - started;
    try { writeAtomic(resFile, JSON.stringify(out)); } catch (e) { log("could not write result: " + e.message, "err"); }
    busy = null;
    count++;
    heartbeat();
    if (IS_PANEL) { $("count").textContent = count; $("last").textContent = cmd.fn + " " + out.bridgeMs + "ms"; }
    log((out.ok ? "✓ " : "✗ ") + cmd.fn + " (" + out.bridgeMs + " ms)" + (out.ok ? "" : " — " + (out.error && out.error.message)), out.ok ? "ok" : "err");
    status("connected", "on");
  }

  function start() {
    ensureDir();
    heartbeat();
    setInterval(heartbeat, 1000);
    try {
      watcher = fs.watch(DIR, function (evt, fname) { if (!fname || /^cmd_/.test(fname)) drain(); });
    } catch (e) { log("fs.watch unavailable, polling only", "info"); }
    setInterval(drain, 400); // safety net in case a watch event is missed
    status("connected", "on");
    log("bridge ready in " + DIR + " (" + (IS_PANEL ? "panel" : "headless") + ", engine " + ENGINE + ")", "info");
    drain();
  }
  try { start(); } catch (e) { reportFatal(e); }
})();
