// UXP handlers, sent by the MCP server to the UXP loader on connect and evaluated
// there with (ppro, uxp) in scope. Must `return` an object of async functions.
// Modern JavaScript (UXP V8). Times: seconds in, seconds out.
const TPS = 254016000000;
const sec = (t) => (t == null ? null : t.seconds !== undefined ? t.seconds : t.ticks !== undefined ? Number(t.ticks) / TPS : Number(t));
const tt = (s) => ppro.TickTime.createWithSeconds(Number(s));
const err = (code, message) => Object.assign(new Error(message), { code });

async function project() {
  const p = await ppro.Project.getActiveProject();
  if (!p) throw err("NO_PROJECT", "No project is open.");
  return p;
}
async function sequence(p, ref) {
  if (!ref) {
    const s = await p.getActiveSequence();
    if (!s) throw err("NO_ACTIVE_SEQUENCE", "No active sequence.");
    return s;
  }
  for (const s of await p.getSequences()) if (s.name === ref || String(s.guid) === ref) return s;
  throw err("SEQUENCE_NOT_FOUND", "Sequence not found: " + ref);
}
// One undoable transaction (a real Premiere undo step).
async function transact(p, label, build) {
  let ok = false;
  await p.lockedAccess(() => {
    ok = p.executeTransaction((compound) => {
      for (const a of build()) compound.addAction(a);
    }, label);
  });
  return ok;
}
function surface() {
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
const has = (cls, m) => { try { const v = ppro[cls]; return !!v && (typeof v[m] === "function" || (v.prototype && typeof v.prototype[m] === "function")); } catch (e) { return false; } };

return {
  // Capability probe: which actions this Premiere's UXP API can do.
  async probe(a) {
    const caps = {
      "playhead.get": has("Sequence", "getPlayerPosition"),
      "playhead.set": has("Sequence", "setPlayerPosition"),
      "markers.list": has("Markers", "getMarkers"),
      "markers.add": has("Markers", "createAddMarkerAction"),
      "sequence.list": has("Project", "getSequences"),
      "selection.get": has("Sequence", "getSelection"),
      "transaction": has("Project", "executeTransaction"),
      "otio.import": has("Project", "importSequencesFromOTIO") || has("Project", "importOTIO"),
    };
    const out = { uxp: true, version: (uxp.host && uxp.host.version) || "", capabilities: caps };
    if (a && a.surface) out.api = surface();
    return out;
  },
  async state() {
    const p = await project();
    const s = await p.getActiveSequence();
    const out = { project: { name: p.name, path: p.path } };
    if (s) out.sequence = { name: s.name, playhead: sec(await s.getPlayerPosition()) };
    return out;
  },
  async get_playhead(a) {
    const p = await project();
    const s = await sequence(p, a.sequence);
    return { playhead: sec(await s.getPlayerPosition()) };
  },
  async set_playhead(a) {
    const p = await project();
    const s = await sequence(p, a.sequence);
    await s.setPlayerPosition(tt(a.seconds));
    const now = sec(await s.getPlayerPosition());
    return { playhead: now, verified: Math.abs(now - a.seconds) < 0.05 };
  },
  async markers(a) {
    const p = await project();
    const s = await sequence(p, a.sequence);
    const ms = await ppro.Markers.getMarkers(s);
    const list = (await ms.getMarkers()) || [];
    const out = [];
    for (const m of list) out.push({ name: await m.getName(), start: sec(await m.getStart()), duration: sec(await m.getDuration()) });
    return { markers: out };
  },
  async add_markers(a) {
    const p = await project();
    const s = await sequence(p, a.sequence);
    const ms = await ppro.Markers.getMarkers(s);
    const list = a.markers || [];
    const ok = await transact(p, "MCP add markers", () => list.map((m) => ms.createAddMarkerAction(m.name || "", "Comment", tt(m.time), tt(m.duration || 0), m.comment || "")));
    return { added: list.length, transaction: ok, undoable: true };
  },
  // Escape hatch (unsafe-script profile only, enforced by the server).
  async js(a) {
    const f = new Function("ppro", "uxp", "args", "return (async () => {" + a.code + "})();");
    const r = await f(ppro, uxp, a.args || {});
    return { result: r === undefined ? null : r };
  },
};
