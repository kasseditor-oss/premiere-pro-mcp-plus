/*
 * Premiere Pro MCP Plus - ExtendScript host library.
 *
 * Loaded once into Premiere's ExtendScript engine by the CEP panel and then
 * called as JSON-RPC: $.__mcpPlus.call("fn", "<json args>") -> "<json result>".
 * Unlike string-templated scripts, arguments never get spliced into code, so
 * quoting bugs and script injection are impossible and Premiere parses this
 * file once instead of on every command.
 *
 * ES3 only: var, no arrow functions, no let/const, no Array.prototype.map etc.
 */
(function () {
  var LIB_VERSION = "__LIB_VERSION__";
  var TPS = 254016000000; // ticks per second
  var H = {}; // public handlers

  // ---------------------------------------------------------------- JSON
  function esc(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i), code = s.charCodeAt(i);
      if (c === "\"") out += "\\\"";
      else if (c === "\\") out += "\\\\";
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (code < 32 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029) {
        var h = code.toString(16);
        while (h.length < 4) h = "0" + h;
        out += "\\u" + h;
      } else out += c;
    }
    return out;
  }
  function stringify(v, depth) {
    depth = depth || 0;
    if (depth > 40) return "null";
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return "\"" + esc(v) + "\"";
    if (t === "function") return "null";
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(stringify(v[i], depth + 1));
      return "[" + a.join(",") + "]";
    }
    var parts = [];
    for (var k in v) {
      if (!v.hasOwnProperty(k)) continue;
      var val = v[k];
      if (val === undefined || typeof val === "function") continue;
      parts.push("\"" + esc(k) + "\":" + stringify(val, depth + 1));
    }
    return "{" + parts.join(",") + "}";
  }
  function parse(s) {
    if (s === undefined || s === null || s === "") return {};
    // Input is produced by JSON.stringify on the MCP server (trusted, private
    // bridge directory), so a parenthesised eval is a valid JSON parser here.
    return eval("(" + s + ")");
  }

  // ---------------------------------------------------------------- errors
  function Fail(code, message, hint) {
    this.code = code;
    this.message = message;
    this.hint = hint;
  }
  function fail(code, message, hint) { throw new Fail(code, message, hint); }

  // ---------------------------------------------------------------- utils
  function r3(n) { return Math.round(n * 1000) / 1000; }
  function secToTicks(s) { return Math.round(parseFloat(s) * TPS); }
  function ticksToSec(t) { return parseFloat(t) / TPS; }
  function timeFromSec(s) { var t = new Time(); t.ticks = String(secToTicks(s)); return t; }
  function timeFromTicks(ticks) { var t = new Time(); t.ticks = String(Math.round(ticks)); return t; }
  function tsec(timeObj) { try { return parseFloat(timeObj.ticks) / TPS; } catch (e) { return NaN; } }
  function has(o, k) { return o !== null && o !== undefined && o[k] !== undefined && o[k] !== null; }
  function asArray(v) { if (v === undefined || v === null) return []; return v instanceof Array ? v : [v]; }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }
  function lower(s) { return String(s).toLowerCase(); }
  function normName(s) { return lower(s).replace(/[\s_\-\.]+/g, ""); }

  function ensureQE() {
    try { app.enableQE(); } catch (e) {}
    if (typeof qe === "undefined" || !qe || !qe.project) fail("QE_UNAVAILABLE", "Premiere's QE DOM is not available on this host.");
    return qe;
  }

  // ---------------------------------------------------------------- project tree
  function requireProject() {
    if (!app.project || !app.project.rootItem) fail("NO_PROJECT", "No project is open in Premiere Pro.", "Open or create a project first (open_project / new_project).");
    return app.project;
  }
  function itemType(item) {
    var t = item.type;
    if (t === 2) return "bin";
    if (t === 3) return "root";
    try { if (item.isSequence && item.isSequence()) return "sequence"; } catch (e) {}
    if (t === 4) return "file";
    return "clip";
  }
  function walk(bin, path, visit) {
    var kids = bin.children;
    if (!kids) return;
    for (var i = 0; i < kids.numItems; i++) {
      var it = kids[i];
      if (!it) continue;
      if (visit(it, path) === false) return false;
      if (it.type === 2) {
        if (walk(it, path ? path + "/" + it.name : it.name, visit) === false) return false;
      }
    }
  }
  function findItemByNodeId(nodeId) {
    var found = null;
    walk(requireProject().rootItem, "", function (it) { if (String(it.nodeId) === String(nodeId)) { found = it; return false; } });
    return found;
  }
  function binByPath(path, create) {
    var root = requireProject().rootItem;
    if (!path || path === "/" ) return root;
    var parts = String(path).replace(/\\/g, "/").split("/");
    var cur = root;
    for (var p = 0; p < parts.length; p++) {
      var name = trim(parts[p]);
      if (!name) continue;
      var next = null;
      for (var i = 0; i < cur.children.numItems; i++) {
        var c = cur.children[i];
        if (c && c.type === 2 && c.name === name) { next = c; break; }
      }
      if (!next) {
        if (!create) fail("BIN_NOT_FOUND", "Bin not found: " + path);
        next = cur.createBin(name);
        if (!next) fail("BIN_CREATE_FAILED", "Could not create bin " + name);
      }
      cur = next;
    }
    return cur;
  }
  function itemMediaPath(it) { try { return it.getMediaPath() || ""; } catch (e) { return ""; } }
  // Resolve a project item from a node id, exact name, bin path ("Bin/Name"), or media path.
  function resolveItem(ref) {
    if (ref === undefined || ref === null || ref === "") fail("BAD_ARGS", "A project item reference is required.");
    var s = String(ref);
    var byId = /^[0-9a-fA-F]{4,}$/.test(s) ? findItemByNodeId(s) : null; // node ids look like "000f4241"
    if (byId) return byId;
    var wantPath = lower(s.replace(/\\/g, "/"));
    var exact = null, byMedia = null, byPath = null, ci = null;
    walk(requireProject().rootItem, "", function (it, path) {
      if (it.type === 2) return;
      var full = path ? path + "/" + it.name : it.name;
      if (it.name === s && !exact) exact = it;
      if (!byPath && lower(full) === wantPath) byPath = it;
      if (!ci && lower(it.name) === lower(s)) ci = it;
      if (!byMedia) {
        var mp = lower(itemMediaPath(it).replace(/\\/g, "/"));
        if (mp && mp === wantPath) byMedia = it;
      }
    });
    var r = byMedia || byPath || exact || ci;
    if (!r) fail("ITEM_NOT_FOUND", "Project item not found: " + s, "Use list_project_items to get node ids, or import_media first.");
    return r;
  }
  function describeItem(it, path, details) {
    var d = { id: String(it.nodeId), name: it.name, type: itemType(it) };
    if (path !== undefined) d.bin = path || "/";
    if (d.type !== "bin") {
      var mp = itemMediaPath(it);
      if (mp) d.media = mp;
      if (details) {
        try { var o = it.getOutPoint(); var inn = it.getInPoint(); d.duration = r3(tsec(o) - tsec(inn)); } catch (e) {}
        try { if (it.isOffline()) d.offline = true; } catch (e2) {}
        try { var fi = it.getFootageInterpretation(); if (fi) { d.fps = r3(fi.frameRate); } } catch (e3) {}
        try { d.label = it.getColorLabel(); } catch (e4) {}
        try { if (it.hasProxy && it.hasProxy()) d.proxy = true; } catch (e5) {}
      }
    }
    return d;
  }

  // ---------------------------------------------------------------- sequences & tracks
  function allSequences() {
    var p = requireProject(), out = [];
    for (var i = 0; i < p.sequences.numSequences; i++) out.push(p.sequences[i]);
    return out;
  }
  function getSequence(ref) {
    var p = requireProject();
    if (ref === undefined || ref === null || ref === "") {
      if (!p.activeSequence) fail("NO_ACTIVE_SEQUENCE", "No active sequence.", "Open a sequence (open_sequence) or create one (create_sequence).");
      return p.activeSequence;
    }
    var seqs = allSequences(), s = String(ref);
    for (var i = 0; i < seqs.length; i++) if (String(seqs[i].sequenceID) === s || String(seqs[i].projectItem.nodeId) === s) return seqs[i];
    for (var j = 0; j < seqs.length; j++) if (seqs[j].name === s) return seqs[j];
    for (var k = 0; k < seqs.length; k++) if (lower(seqs[k].name) === lower(s)) return seqs[k];
    fail("SEQUENCE_NOT_FOUND", "Sequence not found: " + s, "Use list_sequences.");
  }
  function frameTicks(seq) { var t = parseFloat(seq.timebase); return isFinite(t) && t > 0 ? t : TPS / 30; }
  function fps(seq) { return TPS / frameTicks(seq); }
  function snapTicks(seq, ticks) { var f = frameTicks(seq); return Math.round(Math.round(ticks / f) * f); }
  function seqTime(seq, seconds) { return timeFromTicks(snapTicks(seq, secToTicks(seconds))); }
  function frameSize(seq) {
    try { var s = seq.getSettings(); return { w: s.videoFrameWidth, h: s.videoFrameHeight }; } catch (e) { return { w: seq.frameSizeHorizontal, h: seq.frameSizeVertical }; }
  }
  // Track refs: "V1", "A2" (1-based, as in Premiere's UI), or {type:"video", index:0}.
  function parseTrackRef(ref) {
    if (ref === undefined || ref === null) return null;
    if (typeof ref === "object") return { video: ref.type !== "audio", index: ref.index };
    var m = /^\s*([VvAa])\s*(\d+)\s*$/.exec(String(ref));
    if (!m) fail("BAD_TRACK", "Track must look like V1 or A2, got: " + ref);
    return { video: lower(m[1]) === "v", index: parseInt(m[2], 10) - 1 };
  }
  function trackLabel(video, index) { return (video ? "V" : "A") + (index + 1); }
  function addTracksQE(seq, v, a) {
    if (v <= 0 && a <= 0) return;
    ensureQE();
    activate(seq);
    var qs = qe.project.getActiveSequence();
    if (!qs) fail("QE_NO_SEQUENCE", "QE could not resolve the active sequence.");
    if (v > 0) qs.addTracks(v, seq.videoTracks.numTracks, 0, 1, seq.audioTracks.numTracks, 0, 0);
    if (a > 0) qs.addTracks(0, seq.videoTracks.numTracks, a, 1, seq.audioTracks.numTracks, 0, 0);
  }
  function getTrack(seq, ref, autoCreate) {
    var t = parseTrackRef(ref);
    var coll = t.video ? seq.videoTracks : seq.audioTracks;
    if (t.index < 0) fail("BAD_TRACK", "Track index must be >= 1.");
    if (t.index >= coll.numTracks) {
      if (!autoCreate) fail("TRACK_NOT_FOUND", trackLabel(t.video, t.index) + " does not exist (sequence has " + coll.numTracks + ").", "Pass auto_create_tracks: true or call add_tracks.");
      var missing = t.index - coll.numTracks + 1;
      addTracksQE(seq, t.video ? missing : 0, t.video ? 0 : missing);
      coll = t.video ? seq.videoTracks : seq.audioTracks;
      if (t.index >= coll.numTracks) fail("TRACK_CREATE_FAILED", "Premiere did not create " + trackLabel(t.video, t.index));
    }
    return { track: coll[t.index], video: t.video, index: t.index, label: trackLabel(t.video, t.index) };
  }
  function activate(seq) {
    var p = requireProject();
    if (p.activeSequence && String(p.activeSequence.sequenceID) === String(seq.sequenceID)) return;
    p.openSequence(seq.sequenceID);
  }
  function qeSequenceFor(seq) {
    ensureQE();
    activate(seq);
    var qs = qe.project.getActiveSequence();
    if (!qs) fail("QE_NO_SEQUENCE", "QE could not resolve the sequence.");
    return qs;
  }
  function timecodeFor(seq, ticks) {
    var tb = frameTicks(seq);
    var frame = Math.floor(parseFloat(ticks) / tb + 0.000001);
    if (frame < 0) frame = 0;
    try {
      var fr = new Time(); fr.ticks = String(tb);
      var t = new Time(); t.ticks = String(frame * tb);
      var fmt = 100;
      try { fmt = seq.getSettings().videoDisplayFormat; } catch (e) {}
      if (typeof t.getFormatted === "function") return t.getFormatted(fr, fmt);
    } catch (e2) {}
    var nominal = Math.round(TPS / tb);
    return pad2(Math.floor(frame / (nominal * 3600))) + ":" + pad2(Math.floor(frame / (nominal * 60)) % 60) + ":" + pad2(Math.floor(frame / nominal) % 60) + ":" + pad2(frame % nominal);
  }

  // ---------------------------------------------------------------- clips
  function clipInfo(c, label, idx, opts) {
    var d = {
      id: String(c.nodeId),
      track: label,
      index: idx,
      name: c.name,
      start: r3(tsec(c.start)),
      end: r3(tsec(c.end)),
      "in": r3(tsec(c.inPoint)),
      out: r3(tsec(c.outPoint))
    };
    try { if (c.disabled) d.disabled = true; } catch (e) {}
    try { var sp = c.getSpeed(); if (sp && Math.abs(sp - 1) > 0.0001 && Math.abs(sp - 100) > 0.0001) d.speed = sp; } catch (e2) {}
    try { if (c.isSpeedReversed && c.isSpeedReversed()) d.reversed = true; } catch (e3) {}
    if (opts && opts.media) { try { if (c.projectItem) { d.item = String(c.projectItem.nodeId); var mp = itemMediaPath(c.projectItem); if (mp) d.media = mp; } } catch (e4) {} }
    if (opts && opts.effects) {
      var fx = [];
      try {
        for (var i = 0; i < c.components.numItems; i++) {
          var comp = c.components[i];
          if (!isBuiltIn(comp)) fx.push(comp.displayName);
        }
      } catch (e5) {}
      if (fx.length) d.effects = fx;
    }
    if (opts && opts.selected) { try { if (c.isSelected()) d.selected = true; } catch (e6) {} }
    return d;
  }
  function eachClip(seq, fn) {
    var groups = [[seq.videoTracks, true], [seq.audioTracks, false]];
    for (var g = 0; g < groups.length; g++) {
      var coll = groups[g][0];
      for (var t = 0; t < coll.numTracks; t++) {
        var tr = coll[t];
        for (var i = 0; i < tr.clips.numItems; i++) {
          if (fn(tr.clips[i], trackLabel(groups[g][1], t), i, tr, groups[g][1]) === false) return;
        }
      }
    }
  }
  function findClip(seq, id) {
    var res = null;
    eachClip(seq, function (c, label, idx, tr, video) { if (String(c.nodeId) === String(id)) { res = { clip: c, track: label, index: idx, trackObj: tr, video: video }; return false; } });
    return res;
  }
  // Clip selector: { ids, track/tracks, name_regex, selected, start_min, start_max, at, every_nth, offset, limit }
  function selectClips(seq, sel) {
    sel = sel || {};
    if (typeof sel === "string" || sel instanceof Array) sel = { ids: asArray(sel) };
    var out = [];
    var ids = null;
    if (sel.ids) { ids = {}; var a = asArray(sel.ids); for (var i = 0; i < a.length; i++) ids[String(a[i])] = true; }
    var tracks = null;
    var tl = asArray(sel.tracks || sel.track);
    if (tl.length) { tracks = {}; for (var j = 0; j < tl.length; j++) tracks[String(tl[j]).toUpperCase()] = true; }
    var re = sel.name_regex ? new RegExp(sel.name_regex, sel.case_sensitive ? "" : "i") : null;
    var kind = sel.kind; // "video" | "audio"
    eachClip(seq, function (c, label, idx, tr, video) {
      if (ids && !ids[String(c.nodeId)]) return;
      if (tracks && !tracks[label]) return;
      if (kind === "video" && !video) return;
      if (kind === "audio" && video) return;
      if (re && !re.test(c.name)) return;
      var s = tsec(c.start), e = tsec(c.end);
      if (has(sel, "start_min") && s < sel.start_min - 0.0005) return;
      if (has(sel, "start_max") && s > sel.start_max + 0.0005) return;
      if (has(sel, "at") && !(s <= sel.at + 0.0005 && e > sel.at + 0.0005)) return;
      if (sel.selected) { var isSel = false; try { isSel = c.isSelected(); } catch (ee) {} if (!isSel) return; }
      out.push({ clip: c, track: label, index: idx, trackObj: tr, video: video });
    });
    if (sel.every_nth && sel.every_nth > 1) {
      var off = sel.offset || 0, f = [];
      for (var k = 0; k < out.length; k++) if ((k - off) % sel.every_nth === 0 && k >= off) f.push(out[k]);
      out = f;
    }
    if (sel.limit) out = out.slice(0, sel.limit);
    return out;
  }
  function requireClips(seq, sel) {
    var list = selectClips(seq, sel);
    if (!list.length) fail("NO_CLIPS_MATCHED", "No timeline clips matched the selector.", "Check ids with get_timeline, or relax the selector.");
    return list;
  }
  function findPlacedClip(trackObj, ticks, nodeId, tolerance) {
    var best = null, bestD = 1e30;
    for (var i = 0; i < trackObj.clips.numItems; i++) {
      var c = trackObj.clips[i];
      var d = Math.abs(parseFloat(c.start.ticks) - ticks);
      var matches = true;
      try { if (nodeId && c.projectItem && String(c.projectItem.nodeId) !== String(nodeId)) matches = false; } catch (e) {}
      if (matches && d < bestD) { best = c; bestD = d; }
    }
    return best && bestD <= tolerance ? best : null;
  }

  // ---------------------------------------------------------------- components & properties
  var BUILTIN_MATCH = { "AE.ADBE Motion": 1, "AE.ADBE Opacity": 1, "AE.ADBE Time Remapping": 1, "AE.ADBE Graphic Group": 1, "AE.ADBE Text": 1, "AE.ADBE Shape": 1 };
  function isBuiltIn(comp) {
    var m = "";
    try { m = String(comp.matchName || ""); } catch (e) {}
    if (BUILTIN_MATCH[m] || /^Internal /.test(m) || /^AE\.ADBE (Vector|Shape|Graphic)/.test(m)) return true;
    return false;
  }
  var ALIASES = {
    motion: "AE.ADBE Motion", movimento: "AE.ADBE Motion", movimiento: "AE.ADBE Motion", transform: "AE.ADBE Motion",
    opacity: "AE.ADBE Opacity", opacidade: "AE.ADBE Opacity", opacidad: "AE.ADBE Opacity",
    volume: "Internal Volume", level: "Internal Volume"
  };
  function findComponent(clip, ref) {
    if (ref === undefined || ref === null) fail("BAD_ARGS", "effect is required");
    var comps = clip.components;
    if (typeof ref === "number") {
      if (ref < 0 || ref >= comps.numItems) fail("EFFECT_NOT_FOUND", "Component index out of range: " + ref);
      return comps[ref];
    }
    var s = String(ref), n = normName(s), alias = ALIASES[n] || null;
    for (var pass = 0; pass < 3; pass++) {
      for (var i = comps.numItems - 1; i >= 0; i--) { // last match wins = most recently added
        var c = comps[i], mn = "", dn = "";
        try { mn = String(c.matchName); dn = String(c.displayName); } catch (e) {}
        if (pass === 0 && (mn === s || dn === s)) return c;
        if (pass === 1 && alias && (mn === alias || mn.indexOf(alias) === 0)) return c;
        if (pass === 2 && (normName(dn) === n || normName(mn) === n || normName(mn).indexOf(n) >= 0 && n.length > 3)) return c;
      }
    }
    return null;
  }
  function requireComponent(clip, ref) {
    var c = findComponent(clip, ref);
    if (!c) {
      var names = [];
      for (var i = 0; i < clip.components.numItems; i++) names.push(clip.components[i].displayName);
      fail("EFFECT_NOT_FOUND", "Effect '" + ref + "' is not on clip '" + clip.name + "'. Present: " + names.join(", "), "Apply it first with apply_effects.");
    }
    return c;
  }
  var PROP_ALIASES = {
    scale: ["Scale", "Escala", "Uniform Scale"], position: ["Position", "Posição", "Posicao", "Posición"], rotation: ["Rotation", "Rotação", "Rotacao", "Rotación"],
    anchor: ["Anchor Point", "Ponto de ancoragem", "Punto de anclaje"], opacity: ["Opacity", "Opacidade", "Opacidad"],
    level: ["Level", "Nível", "Nivel"], scalewidth: ["Scale Width", "Largura da escala"], uniformscale: ["Uniform Scale", "Escala uniforme"],
    antiflicker: ["Anti-flicker Filter"], blurriness: ["Blurriness", "Amount", "Desfoque", "Quantidade", "Intensidade"], amount: ["Amount", "Blurriness", "Quantidade"], blendmode: ["Blend Mode", "Modo de mesclagem"]
  };
  // Motion property order is stable: 0 Position, 1 Scale, 2 Scale Width, 3 Uniform Scale, 4 Rotation, 5 Anchor Point, 6 Anti-flicker, 7-10 Crop L/T/R/B (Premiere 2023+).
  var MOTION_INDEX = { position: 0, scale: 1, scalewidth: 2, uniformscale: 3, rotation: 4, anchor: 5, anchorpoint: 5, antiflicker: 6, cropleft: 7, croptop: 8, cropright: 9, cropbottom: 10 };
  function findProp(comp, ref) {
    var props = comp.properties;
    if (typeof ref === "number") return ref >= 0 && ref < props.numItems ? props[ref] : null;
    var s = String(ref), n = normName(s);
    for (var i = 0; i < props.numItems; i++) if (props[i].displayName === s) return props[i];
    for (var j = 0; j < props.numItems; j++) if (normName(props[j].displayName) === n) return props[j];
    var al = PROP_ALIASES[n];
    if (al) for (var a = 0; a < al.length; a++) for (var k = 0; k < props.numItems; k++) if (normName(props[k].displayName) === normName(al[a])) return props[k];
    var mn = ""; try { mn = comp.matchName; } catch (e) {}
    if (mn === "AE.ADBE Motion" && MOTION_INDEX[n] !== undefined && MOTION_INDEX[n] < props.numItems) return props[MOTION_INDEX[n]];
    if (mn === "AE.ADBE Opacity" && n === "opacity" && props.numItems > 0) return props[0];
    if (/^Internal Volume/.test(mn) && (n === "level" || n === "volume") && props.numItems > 1) return props[1];
    return null;
  }
  function requireProp(comp, ref) {
    var p = findProp(comp, ref);
    if (!p) {
      var names = [];
      for (var i = 0; i < comp.properties.numItems; i++) names.push(comp.properties[i].displayName);
      fail("PROPERTY_NOT_FOUND", "Property '" + ref + "' not found on '" + comp.displayName + "'. Available: " + names.join(", "));
    }
    return p;
  }
  function readValue(p) {
    var v;
    try { v = p.getValue(); } catch (e) { return null; }
    if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(typeof v[i] === "number" ? r3x(v[i]) : v[i]); return a; }
    if (typeof v === "number") return r3x(v);
    if (typeof v === "string" && v.length > 300) return v.substring(0, 300) + "...";
    return v;
  }
  function r3x(n) { return Math.round(n * 100000) / 100000; }
  function isColorProp(p) {
    try { var v = p.getValue(); return typeof v === "number" && v > 4294967 && false; } catch (e) { return false; }
  }
  function coerceValue(p, value) {
    // Colors may be passed as "#RRGGBB" or [a,r,g,b]
    if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
      return { color: [255, parseInt(value.substr(1, 2), 16), parseInt(value.substr(3, 2), 16), parseInt(value.substr(5, 2), 16)] };
    }
    if (value && typeof value === "object" && !(value instanceof Array) && value.color) return { color: value.color };
    return { value: value };
  }
  function applyValue(p, value) {
    var cv = coerceValue(p, value);
    if (cv.color) {
      var c = cv.color;
      if (typeof p.setColorValue !== "function") fail("BAD_VALUE", "Property " + p.displayName + " is not a color property");
      p.setColorValue(c[0], c[1], c[2], c[3], true);
      return;
    }
    if (p.isTimeVarying && p.isTimeVarying()) {
      fail("PROPERTY_ANIMATED", "Property '" + p.displayName + "' has keyframes; a static set would be ignored.", "Use add_keyframes, or remove_keyframes first.");
    }
    p.setValue(cv.value, true);
  }
  function applyValueAtKey(p, time, value) {
    var cv = coerceValue(p, value);
    if (cv.color) fail("BAD_VALUE", "Keyframing color properties is not supported.");
    p.setValueAtKey(time, cv.value, true);
  }

  // Keyframe times live in media time: clip in-point + (offset * speed).
  function keyBase(clip) {
    var speed = 1, rev = false;
    try { speed = clip.getSpeed(); } catch (e) {}
    if (!(speed > 0)) speed = 1;
    if (speed > 10) speed = speed / 100; // older hosts report percent
    try { rev = !!clip.isSpeedReversed(); } catch (e2) {}
    if (rev) fail("UNSUPPORTED", "Keyframes on reversed clips are not supported.");
    return { inTicks: parseFloat(clip.inPoint.ticks), speed: speed, dur: tsec(clip.end) - tsec(clip.start), start: tsec(clip.start) };
  }
  function keyTime(base, clipSeconds) { return timeFromTicks(base.inTicks + secToTicks(clipSeconds * base.speed)); }
  function keyClipSeconds(base, t) { return r3x(ticksToSec(parseFloat(t.ticks) - base.inTicks) / base.speed); }
  var INTERP = { linear: 0, hold: 4, bezier: 5, auto_bezier: 5, ease: 5, continuous_bezier: 5, time: 6 };

  // ---------------------------------------------------------------- QE helpers
  function qeCatalog(list) {
    var out = [];
    if (!list) return out;
    var n = NaN;
    try { if (list.numItems !== undefined) n = Number(list.numItems); } catch (e) {}
    if (isNaN(n)) try { n = Number(list.length); } catch (e2) {}
    if (isNaN(n)) return out;
    for (var i = 0; i < n; i++) {
      var e3 = null;
      try { e3 = list[i]; } catch (ex) {}
      if (e3 === null || e3 === undefined) continue;
      out.push(typeof e3 === "string" ? e3 : String(e3.name));
    }
    return out;
  }
  var _catalogCache = {};
  function catalog(kind) {
    if (_catalogCache[kind]) return _catalogCache[kind];
    ensureQE();
    var list = null;
    if (kind === "video") list = qe.project.getVideoEffectList();
    else if (kind === "audio") list = qe.project.getAudioEffectList();
    else if (kind === "video_transition") list = qe.project.getVideoTransitionList();
    else if (kind === "audio_transition") list = qe.project.getAudioTransitionList();
    var c = qeCatalog(list);
    if (c.length) _catalogCache[kind] = c;
    return c;
  }
  // Common English names -> alternatives seen in localized hosts.
  var EFFECT_SYNONYMS = {
    "gaussianblur": ["Gaussian Blur", "Desfoque gaussiano", "Desenfoque gaussiano", "Flou gaussien", "Gaußscher Weichzeichner"],
    "crossdissolve": ["Cross Dissolve", "Dissolução cruzada", "Dissolvência cruzada", "Disolución cruzada", "Fondu enchaîné"],
    "constantpower": ["Constant Power", "Potência constante", "Potencia constante", "Puissance constante"],
    "constantgain": ["Constant Gain", "Ganho constante", "Ganancia constante"],
    "diptoblack": ["Dip to Black", "Imersão para preto", "Mergulhar no preto", "Fundido a negro"],
    "diptowhite": ["Dip to White", "Imersão para branco", "Mergulhar no branco", "Fundido a blanco"],
    "lumetricolor": ["Lumetri Color", "Cor Lumetri", "Color de Lumetri"],
    "crop": ["Crop", "Cortar", "Recortar", "Corte"],
    "transform": ["Transform", "Transformar", "Transformação"],
    "warpstabilizer": ["Warp Stabilizer", "Estabilizador de distorção", "Estabilizador de deformación"],
    "dropshadow": ["Drop Shadow", "Sombra projetada", "Sombra paralela"],
    "mirror": ["Mirror", "Espelho", "Espejo"],
    "tint": ["Tint", "Tonalidade", "Tinta", "Matiz"],
    "ultrakey": ["Ultra Key", "Ultra Key"],
    "directionalblur": ["Directional Blur", "Desfoque direcional", "Desenfoque direccional"],
    "filmdissolve": ["Film Dissolve", "Dissolução de filme"],
    "additivedissolve": ["Additive Dissolve", "Dissolução aditiva"],
    "push": ["Push", "Empurrar"],
    "slide": ["Slide", "Deslizar"]
  };
  function resolveCatalogName(kind, wanted) {
    var cat = catalog(kind);
    var w = String(wanted), nw = normName(w);
    for (var i = 0; i < cat.length; i++) if (cat[i] === w) return cat[i];
    for (var j = 0; j < cat.length; j++) if (normName(cat[j]) === nw) return cat[j];
    var syn = EFFECT_SYNONYMS[nw];
    if (syn) for (var s = 0; s < syn.length; s++) for (var k = 0; k < cat.length; k++) if (normName(cat[k]) === normName(syn[s])) return cat[k];
    if (!cat.length) return w; // empty catalog on some hosts: try the name directly
    var sugg = [];
    for (var m = 0; m < cat.length && sugg.length < 8; m++) if (normName(cat[m]).indexOf(nw.substring(0, 4)) >= 0) sugg.push(cat[m]);
    fail("EFFECT_UNKNOWN", "No " + kind.replace("_", " ") + " named '" + w + "'." + (sugg.length ? " Close matches: " + sugg.join(", ") : ""), "Use list_available_effects to see exact (possibly localized) names.");
  }
  function qeObject(kind, name) {
    ensureQE();
    var o = null;
    if (kind === "video") o = qe.project.getVideoEffectByName(name);
    else if (kind === "audio") o = qe.project.getAudioEffectByName(name);
    else if (kind === "video_transition") o = qe.project.getVideoTransitionByName(name);
    else if (kind === "audio_transition") o = qe.project.getAudioTransitionByName(name);
    if (!o) fail("EFFECT_UNKNOWN", "Premiere returned nothing for " + kind + " '" + name + "'.");
    return o;
  }
  function qeClipFor(seq, entry) {
    var qs = qeSequenceFor(seq);
    var qt = entry.video ? qs.getVideoTrackAt(trackIndexOf(seq, entry)) : qs.getAudioTrackAt(trackIndexOf(seq, entry));
    var want = parseFloat(entry.clip.start.ticks);
    for (var i = 0; i < qt.numItems; i++) {
      var it = null;
      try { it = qt.getItemAt(i); } catch (e) {}
      if (!it || String(it.type) !== "Clip") continue;
      try { if (Math.abs(parseFloat(it.start.ticks) - want) < 2) return it; } catch (e2) {}
    }
    fail("QE_CLIP_NOT_FOUND", "QE could not address clip '" + entry.clip.name + "' on " + entry.track);
  }
  function trackIndexOf(seq, entry) { return parseInt(entry.track.substring(1), 10) - 1; }

  // ================================================================ HANDLERS
  // ---- status
  H.ping = function () {
    var p = null;
    try { p = app.project; } catch (e) {}
    var res = { ok: true, lib: LIB_VERSION, premiere: app.version, build: app.build, locale: $.locale, os: $.os };
    if (p && p.rootItem) {
      res.project = { name: p.name, path: p.path };
      if (p.activeSequence) res.activeSequence = { id: String(p.activeSequence.sequenceID), name: p.activeSequence.name };
    }
    return res;
  };

  H.get_state = function (a) {
    var p = requireProject();
    var seqs = allSequences(), list = [];
    for (var i = 0; i < seqs.length; i++) list.push({ id: String(seqs[i].sequenceID), name: seqs[i].name });
    var counts = { bins: 0, items: 0, offline: 0 };
    walk(p.rootItem, "", function (it) { if (it.type === 2) counts.bins++; else { counts.items++; try { if (it.isOffline()) counts.offline++; } catch (e) {} } });
    var st = { premiere: app.version, project: { name: p.name, path: p.path }, counts: counts, sequences: list };
    if (p.activeSequence) st.active = summarizeSequence(p.activeSequence);
    return st;
  };
  function summarizeSequence(s) {
    var fsz = frameSize(s);
    var d = { id: String(s.sequenceID), name: s.name, width: fsz.w, height: fsz.h, fps: r3(fps(s)), duration: r3(parseFloat(s.end) / TPS), videoTracks: s.videoTracks.numTracks, audioTracks: s.audioTracks.numTracks };
    try { d.playhead = r3(tsec(s.getPlayerPosition())); } catch (e) {}
    return d;
  }

  // ---- project
  H.project_info = function () { return H.get_state({}); };
  H.save_project = function () { requireProject().save(); return { saved: true, path: app.project.path }; };
  H.save_project_as = function (a) { requireProject().saveAs(a.path); return { saved: true, path: a.path }; };
  H.open_project = function (a) {
    var f = new File(a.path);
    if (!f.exists) fail("FILE_NOT_FOUND", "Project file not found: " + a.path);
    var ok = app.openDocument(f.fsName, true, true, true, true);
    return { opened: !!ok, project: app.project ? app.project.name : null };
  };
  H.new_project = function (a) { var ok = app.newProject(a.path); return { created: !!ok, path: a.path }; };
  H.close_project = function (a) { var ok = requireProject().closeDocument(a.save ? 1 : 0, 0); return { closed: !!ok }; };

  H.list_project_items = function (a) {
    var root = a.bin ? binByPath(a.bin, false) : requireProject().rootItem;
    var re = a.name_regex ? new RegExp(a.name_regex, "i") : null;
    var types = a.types ? asArray(a.types) : null;
    var out = [], limit = a.limit || 500, total = 0;
    var startPath = a.bin || "";
    function visit(bin, path) {
      for (var i = 0; i < bin.children.numItems; i++) {
        var it = bin.children[i];
        if (!it) continue;
        var t = itemType(it);
        var okType = !types || (function () { for (var k = 0; k < types.length; k++) if (types[k] === t) return true; return false; })();
        if (okType && (!re || re.test(it.name))) {
          total++;
          if (out.length < limit) out.push(describeItem(it, path, a.details));
        }
        if (it.type === 2 && a.recursive !== false) visit(it, path ? path + "/" + it.name : it.name);
      }
    }
    visit(root, startPath);
    return { items: out, total: total, truncated: total > out.length };
  };

  H.get_item_info = function (a) {
    var it = resolveItem(a.item);
    var d = describeItem(it, undefined, true);
    try { var fi = it.getFootageInterpretation(); d.interpretation = { frameRate: fi.frameRate, pixelAspectRatio: fi.pixelAspectRatio, fieldType: fi.fieldType, alphaUsage: fi.alphaUsage }; } catch (e) {}
    try { d["in"] = r3(tsec(it.getInPoint())); d.out = r3(tsec(it.getOutPoint())); } catch (e2) {}
    try { var m = it.getMarkers(); if (m) d.markers = m.numMarkers; } catch (e3) {}
    if (a.metadata) {
      try { d.projectMetadata = String(it.getProjectMetadata()).substring(0, 4000); } catch (e4) {}
      try { d.xmp = String(it.getXMPMetadata()).substring(0, 4000); } catch (e5) {}
    }
    return d;
  };

  H.import_files = function (a) {
    var p = requireProject();
    var target = a.bin ? binByPath(a.bin, true) : p.getInsertionBin ? p.getInsertionBin() : p.rootItem;
    if (!target) target = p.rootItem;
    var before = {};
    for (var i = 0; i < target.children.numItems; i++) before[String(target.children[i].nodeId)] = true;
    var paths = asArray(a.paths), missing = [], ok = [];
    for (var j = 0; j < paths.length; j++) { var f = new File(paths[j]); if (f.exists) ok.push(f.fsName); else missing.push(paths[j]); }
    if (!ok.length) fail("FILE_NOT_FOUND", "None of the files exist: " + missing.join(", "));
    var res = p.importFiles(ok, true, target, !!a.as_image_sequence);
    var created = [];
    for (var k = 0; k < target.children.numItems; k++) {
      var c = target.children[k];
      if (!before[String(c.nodeId)]) created.push(describeItem(c, a.bin || "", false));
    }
    return { imported: created, missing: missing, requested: paths.length, premiereReturned: res };
  };

  H.create_bin = function (a) { var b = binByPath(a.path, true); return { id: String(b.nodeId), name: b.name, path: a.path }; };

  H.move_items = function (a) {
    var bin = binByPath(a.bin, true), moved = [];
    var items = asArray(a.items);
    for (var i = 0; i < items.length; i++) { var it = resolveItem(items[i]); it.moveBin(bin); moved.push(String(it.nodeId)); }
    return { moved: moved, bin: a.bin };
  };

  H.rename_item = function (a) { var it = resolveItem(a.item); var old = it.name; it.name = a.name; return { id: String(it.nodeId), from: old, to: it.name }; };

  H.delete_items = function (a) {
    // ExtendScript can delete bins but not single items, so move the items
    // into a scratch bin and delete that bin (Premiere deletes its contents).
    var p = requireProject(), items = asArray(a.items), names = [];
    var scratch = p.rootItem.createBin("__mcp_delete_" + new Date().getTime());
    for (var i = 0; i < items.length; i++) {
      var it = resolveItem(items[i]);
      names.push(it.name);
      if (it.type === 2) { it.deleteBin(); continue; }
      it.moveBin(scratch);
    }
    scratch.deleteBin();
    return { deleted: names };
  };

  H.relink_media = function (a) {
    var it = resolveItem(a.item);
    var f = new File(a.path);
    if (!f.exists) fail("FILE_NOT_FOUND", "File not found: " + a.path);
    if (!it.canChangeMediaPath()) fail("CANNOT_RELINK", "Premiere does not allow changing the media path of '" + it.name + "'.");
    var ok = it.changeMediaPath(f.fsName, true);
    return { id: String(it.nodeId), relinked: !!ok, media: itemMediaPath(it) };
  };
  H.refresh_media = function (a) {
    var items = asArray(a.items), out = [];
    for (var i = 0; i < items.length; i++) { var it = resolveItem(items[i]); try { it.refreshMedia(); out.push(String(it.nodeId)); } catch (e) {} }
    return { refreshed: out };
  };
  H.set_item_label = function (a) {
    var items = asArray(a.items), out = [];
    for (var i = 0; i < items.length; i++) { var it = resolveItem(items[i]); it.setColorLabel(a.label); out.push(String(it.nodeId)); }
    return { labeled: out, label: a.label };
  };
  H.set_item_in_out = function (a) {
    var it = resolveItem(a.item);
    if (a.clear) { it.clearInPoint(); it.clearOutPoint(); return { cleared: true }; }
    if (has(a, "in")) it.setInPoint(timeFromSec(a["in"]), 4);
    if (has(a, "out")) it.setOutPoint(timeFromSec(a.out), 4);
    return { id: String(it.nodeId), "in": r3(tsec(it.getInPoint())), out: r3(tsec(it.getOutPoint())) };
  };
  H.set_interpretation = function (a) {
    var it = resolveItem(a.item);
    var fi = it.getFootageInterpretation();
    if (has(a, "fps")) fi.frameRate = a.fps;
    if (has(a, "pixel_aspect")) fi.pixelAspectRatio = a.pixel_aspect;
    it.setFootageInterpretation(fi);
    var after = it.getFootageInterpretation();
    return { fps: after.frameRate, pixelAspectRatio: after.pixelAspectRatio };
  };
  H.create_subclip = function (a) {
    var it = resolveItem(a.item);
    var sub = makeSubclip(it, a.name || (it.name + " sub"), a["in"], a.out, a.video !== false, a.audio !== false, a.bin);
    return describeItem(sub, a.bin || "", true);
  };
  function makeSubclip(it, name, inS, outS, takeVideo, takeAudio, binPath) {
    var before = {}, parent = null;
    var start = timeFromSec(inS || 0), end;
    if (outS === undefined || outS === null) { try { end = it.getOutPoint(); } catch (e) { end = timeFromSec(3600); } }
    else end = timeFromSec(outS);
    var sub = null, errs = [];
    try { sub = it.createSubClip(name, start.ticks, end.ticks, 0, takeVideo ? 1 : 0, takeAudio ? 1 : 0); } catch (e1) { errs.push(String(e1)); }
    if (!sub) { try { sub = it.createSubClip(name, start, end, 0, takeVideo ? 1 : 0, takeAudio ? 1 : 0); } catch (e2) { errs.push(String(e2)); } }
    if (!sub) fail("SUBCLIP_FAILED", "Premiere did not create the subclip. " + errs.join("; "));
    if (binPath) { try { sub.moveBin(binByPath(binPath, true)); } catch (e3) {} }
    return sub;
  }

  // ---- sequences
  H.list_sequences = function () {
    var seqs = allSequences(), out = [], act = app.project.activeSequence;
    for (var i = 0; i < seqs.length; i++) {
      var d = summarizeSequence(seqs[i]);
      if (act && String(act.sequenceID) === d.id) d.active = true;
      out.push(d);
    }
    return { sequences: out };
  };
  H.open_sequence = function (a) { var s = getSequence(a.sequence); activate(s); return summarizeSequence(app.project.activeSequence); };

  function findSequencePreset() {
    var roots = [Folder.appPackage ? Folder.appPackage.fsName : "", "C:/Program Files/Adobe/Adobe Premiere Pro 2026", "C:/Program Files/Adobe/Adobe Premiere Pro 2025"];
    var cands = ["/Settings/SequencePresets/HD 1080p/HD 1080p 29.97 fps.sqpreset", "/Settings/SequencePresets/HD 1080p/HD 1080p 30 fps.sqpreset", "/Settings/SequencePresets/HD 1080p/HD 1080p 25 fps.sqpreset"];
    for (var r = 0; r < roots.length; r++) {
      if (!roots[r]) continue;
      for (var c = 0; c < cands.length; c++) { var f = new File(roots[r] + cands[c]); if (f.exists) return f.fsName; }
      var dir = new Folder(roots[r] + "/Settings/SequencePresets");
      if (dir.exists) { var found = findFile(dir, /\.sqpreset$/i, 3); if (found) return found.fsName; }
    }
    return null;
  }
  function findFile(folder, re, depth) {
    var files = folder.getFiles();
    for (var i = 0; i < files.length; i++) if (files[i] instanceof File && re.test(files[i].name)) return files[i];
    if (depth > 0) for (var j = 0; j < files.length; j++) if (files[j] instanceof Folder) { var f = findFile(files[j], re, depth - 1); if (f) return f; }
    return null;
  }
  H.create_sequence = function (a) {
    var p = requireProject(), seq = null, name = a.name || "Sequence";
    var before = {};
    var seqs0 = allSequences();
    for (var i = 0; i < seqs0.length; i++) before[String(seqs0[i].sequenceID)] = true;
    if (a.from_clip) {
      var it = resolveItem(a.from_clip);
      seq = p.createNewSequenceFromClips(name, [it], a.bin ? binByPath(a.bin, true) : p.rootItem);
      if (seq && a.empty) {
        var all = selectClips(seq, {});
        for (var k = all.length - 1; k >= 0; k--) try { all[k].clip.remove(false, false); } catch (e) {}
      }
    } else {
      var preset = a.preset_path || findSequencePreset();
      if (!preset) fail("NO_PRESET", "No .sqpreset found; pass preset_path.");
      ensureQE();
      qe.project.newSequence(name, preset);
      var seqs = allSequences();
      for (var j = seqs.length - 1; j >= 0; j--) if (!before[String(seqs[j].sequenceID)]) { seq = seqs[j]; break; }
      if (!seq) fail("SEQUENCE_CREATE_FAILED", "Premiere did not create the sequence.");
      if (a.bin) try { seq.projectItem.moveBin(binByPath(a.bin, true)); } catch (e2) {}
    }
    if (!seq) fail("SEQUENCE_CREATE_FAILED", "Premiere did not create the sequence.");
    if (a.width || a.height || a.fps || a.sample_rate) applySeqSettings(seq, a);
    activate(seq);
    return summarizeSequence(seq);
  };
  function applySeqSettings(seq, a) {
    var s = seq.getSettings();
    if (a.width) s.videoFrameWidth = a.width;
    if (a.height) s.videoFrameHeight = a.height;
    if (a.fps) { var t = new Time(); t.ticks = String(Math.round(TPS / a.fps)); s.videoFrameRate = t; }
    if (a.sample_rate) { var at = new Time(); at.ticks = String(Math.round(TPS / a.sample_rate)); s.audioSampleRate = at; }
    if (has(a, "pixel_aspect")) s.videoPixelAspectRatio = a.pixel_aspect;
    seq.setSettings(s);
  }
  H.set_sequence_settings = function (a) { var s = getSequence(a.sequence); applySeqSettings(s, a); return H.get_sequence_settings(a); };
  H.get_sequence_settings = function (a) {
    var s = getSequence(a.sequence), st = s.getSettings(), out = summarizeSequence(s);
    try { out.pixelAspect = st.videoPixelAspectRatio; out.fieldType = st.videoFieldType; out.audioSampleRate = Math.round(TPS / parseFloat(st.audioSampleRate.ticks)); out.audioChannelType = st.audioChannelType; out.editingMode = st.editingMode; out.displayFormat = st.videoDisplayFormat; out.maxBitDepth = st.maximumBitDepth; out.maxRenderQuality = st.maximumRenderQuality; } catch (e) {}
    try { out["in"] = r3(tsec(s.getInPointAsTime())); out.out = r3(tsec(s.getOutPointAsTime())); } catch (e2) {}
    try { out.workArea = { "in": r3(tsec(s.getWorkAreaInPointAsTime())), out: r3(tsec(s.getWorkAreaOutPointAsTime())) }; } catch (e3) {}
    return out;
  };
  H.duplicate_sequence = function (a) {
    var s = getSequence(a.sequence), before = {};
    var seqs0 = allSequences();
    for (var i = 0; i < seqs0.length; i++) before[String(seqs0[i].sequenceID)] = true;
    s.clone();
    var seqs = allSequences(), copy = null;
    for (var j = 0; j < seqs.length; j++) if (!before[String(seqs[j].sequenceID)]) copy = seqs[j];
    if (!copy) fail("CLONE_FAILED", "Premiere did not clone the sequence.");
    if (a.name) copy.name = a.name;
    return summarizeSequence(copy);
  };
  H.rename_sequence = function (a) { var s = getSequence(a.sequence); s.name = a.name; return { id: String(s.sequenceID), name: s.name }; };
  H.delete_sequence = function (a) { var s = getSequence(a.sequence), n = s.name; app.project.deleteSequence(s); return { deleted: n }; };
  H.set_sequence_range = function (a) {
    var s = getSequence(a.sequence), out = {};
    if (has(a, "in")) s.setInPoint(a["in"]);
    if (has(a, "out")) s.setOutPoint(a.out);
    if (has(a, "work_in")) s.setWorkAreaInPoint(a.work_in);
    if (has(a, "work_out")) s.setWorkAreaOutPoint(a.work_out);
    if (has(a, "playhead")) s.setPlayerPosition(String(snapTicks(s, secToTicks(a.playhead))));
    return H.get_sequence_settings(a);
  };
  H.get_playhead = function (a) { var s = getSequence(a.sequence); return { seconds: r3(tsec(s.getPlayerPosition())), timecode: timecodeFor(s, s.getPlayerPosition().ticks) }; };
  H.set_playhead = function (a) { var s = getSequence(a.sequence); s.setPlayerPosition(String(snapTicks(s, secToTicks(a.seconds)))); return H.get_playhead(a); };

  H.get_timeline = function (a) {
    var s = getSequence(a.sequence);
    var res = summarizeSequence(s);
    var wanted = null;
    if (a.tracks) { wanted = {}; var tl = asArray(a.tracks); for (var i = 0; i < tl.length; i++) wanted[String(tl[i]).toUpperCase()] = true; }
    var opts = { media: a.include_media !== false, effects: a.include_effects !== false, selected: true };
    var tracks = [];
    var groups = [[s.videoTracks, true], [s.audioTracks, false]];
    for (var g = 0; g < groups.length; g++) {
      var coll = groups[g][0];
      for (var t = 0; t < coll.numTracks; t++) {
        var tr = coll[t], label = trackLabel(groups[g][1], t);
        if (wanted && !wanted[label]) continue;
        var td = { track: label, name: tr.name, clips: [] };
        try { if (tr.isMuted()) td.muted = true; } catch (e) {}
        try { if (tr.isLocked()) td.locked = true; } catch (e2) {}
        try { if (tr.isTargeted()) td.targeted = true; } catch (e3) {}
        for (var c = 0; c < tr.clips.numItems; c++) {
          var cl = tr.clips[c], cs = tsec(cl.start), ce = tsec(cl.end);
          if (has(a, "start") && ce <= a.start) continue;
          if (has(a, "end") && cs >= a.end) continue;
          td.clips.push(clipInfo(cl, label, c, opts));
        }
        if (a.include_transitions !== false) {
          try {
            if (tr.transitions && tr.transitions.numItems) {
              td.transitions = [];
              for (var x = 0; x < tr.transitions.numItems; x++) { var tx = tr.transitions[x]; td.transitions.push({ name: tx.name, start: r3(tsec(tx.start)), end: r3(tsec(tx.end)) }); }
            }
          } catch (e4) {}
        }
        if (a.skip_empty && !td.clips.length) continue;
        tracks.push(td);
      }
    }
    res.tracks = tracks;
    try { res.markers = s.markers.numMarkers; } catch (e5) {}
    return res;
  };

  // ---- tracks
  H.add_tracks = function (a) {
    var s = getSequence(a.sequence);
    var v0 = s.videoTracks.numTracks, a0 = s.audioTracks.numTracks;
    ensureQE();
    activate(s);
    var qs = qe.project.getActiveSequence();
    var audioType = a.audio_type === "mono" ? 0 : a.audio_type === "5.1" ? 2 : a.audio_type === "adaptive" ? 3 : 1;
    if (a.video) qs.addTracks(a.video, v0, 0, audioType, a0, 0, 0);
    if (a.audio) qs.addTracks(0, s.videoTracks.numTracks, a.audio, audioType, a0, 0, 0);
    return { videoTracks: s.videoTracks.numTracks, audioTracks: s.audioTracks.numTracks, addedVideo: s.videoTracks.numTracks - v0, addedAudio: s.audioTracks.numTracks - a0 };
  };
  H.delete_track = function (a) {
    var s = getSequence(a.sequence), t = parseTrackRef(a.track);
    var coll = t.video ? s.videoTracks : s.audioTracks;
    if (t.index >= coll.numTracks) fail("TRACK_NOT_FOUND", a.track + " does not exist");
    if (coll[t.index].clips.numItems > 0 && !a.force) fail("TRACK_NOT_EMPTY", a.track + " has clips.", "Pass force: true to delete it anyway.");
    var before = coll.numTracks;
    var qs = qeSequenceFor(s);
    if (t.video) qs.removeVideoTrack(t.index); else qs.removeAudioTrack(t.index);
    var after = (t.video ? s.videoTracks : s.audioTracks).numTracks;
    if (after !== before - 1) fail("TRACK_DELETE_FAILED", "Premiere did not remove " + a.track);
    return { deleted: a.track, remaining: after };
  };
  H.set_track = function (a) {
    var s = getSequence(a.sequence), tracks = asArray(a.tracks || a.track), out = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = getTrack(s, tracks[i], false), tr = t.track;
      if (has(a, "mute")) tr.setMute(a.mute ? 1 : 0);
      if (has(a, "lock")) tr.setLocked(a.lock ? 1 : 0);
      if (has(a, "target")) tr.setTargeted(!!a.target, true);
      if (has(a, "name")) { try { tr.name = a.name; } catch (e) {} }
      var st = { track: t.label, name: tr.name };
      try { st.muted = !!tr.isMuted(); st.locked = !!tr.isLocked(); st.targeted = !!tr.isTargeted(); } catch (e2) {}
      out.push(st);
    }
    return { tracks: out };
  };

  // ---- placing clips
  var SUBCLIP_BIN = "_MCP Plus/Video-only";
  function itemHasAudioAndVideo(it) {
    // Heuristic: stills and audio files never need splitting.
    var mp = lower(itemMediaPath(it));
    if (/\.(png|jpe?g|tiff?|psd|bmp|gif|webp|ai|svg|exr|tga)$/.test(mp)) return false;
    if (/\.(wav|mp3|aif+|m4a|flac|ogg|aac)$/.test(mp)) return false;
    return true;
  }
  var _videoOnlyCache = {};
  function videoOnlyVersion(it) {
    var key = String(it.nodeId);
    if (_videoOnlyCache[key]) { var cached = findItemByNodeId(_videoOnlyCache[key]); if (cached) return cached; }
    // reuse an existing one from a previous session
    var bin = binByPath(SUBCLIP_BIN, true), want = it.name + " [V]";
    for (var i = 0; i < bin.children.numItems; i++) {
      var c = bin.children[i];
      if (c.name === want && lower(itemMediaPath(c)) === lower(itemMediaPath(it))) { _videoOnlyCache[key] = String(c.nodeId); return c; }
    }
    var dur = 0;
    try { dur = tsec(it.getOutPoint()); } catch (e) {}
    try { var inn = tsec(it.getInPoint()); if (inn > 0) { it.clearInPoint(); it.clearOutPoint(); dur = tsec(it.getOutPoint()); } } catch (e2) {}
    var sub = makeSubclip(it, want, 0, dur > 0 ? dur : null, true, false, SUBCLIP_BIN);
    _videoOnlyCache[key] = String(sub.nodeId);
    return sub;
  }

  function placeOne(seq, spec, opts) {
    var it = resolveItem(spec.item);
    var media = spec.media || (spec.video_only ? "video" : spec.audio_only ? "audio" : "both");
    var trackRef = spec.track || (media === "audio" ? "A1" : "V1");
    var tref = parseTrackRef(trackRef);
    if (media === "audio" && tref.video) fail("BAD_ARGS", "media 'audio' needs an audio track (A1...)");
    var placeItem = it;
    if (media === "video" && itemHasAudioAndVideo(it)) placeItem = videoOnlyVersion(it);
    var vt = null, at = null;
    if (tref.video) vt = getTrack(seq, trackRef, opts.auto_create_tracks !== false);
    else at = getTrack(seq, trackRef, opts.auto_create_tracks !== false);
    if (media === "both" && spec.audio_track) at = getTrack(seq, spec.audio_track, opts.auto_create_tracks !== false);
    var startTicks = snapTicks(seq, secToTicks(spec.start || 0));
    // Source range: set on the project item for the duration of the edit.
    var hadIn = has(spec, "in"), hadOut = has(spec, "out") || has(spec, "duration");
    var touchedRange = false;
    if (hadIn || hadOut) {
      var inS = hadIn ? spec["in"] : 0;
      var outS = has(spec, "out") ? spec.out : (has(spec, "duration") ? inS + spec.duration : null);
      try {
        placeItem.setInPoint(timeFromSec(inS), 4);
        if (outS !== null) placeItem.setOutPoint(timeFromSec(outS), 4);
        touchedRange = true;
      } catch (e) {}
    }
    var mode = spec.mode || opts.mode || "overwrite";
    var placed = null, err = null;
    try {
      if (media === "both" && vt) {
        var aIdx = at ? at.index : vt.index;
        if (!at && aIdx >= seq.audioTracks.numTracks) { getTrack(seq, "A" + (aIdx + 1), true); }
        if (mode === "insert") seq.insertClip(placeItem, String(startTicks), vt.index, aIdx);
        else seq.overwriteClip(placeItem, String(startTicks), vt.index, aIdx);
      } else {
        var tt = vt || at;
        if (mode === "insert") tt.track.insertClip(placeItem, ticksToSec(startTicks));
        else tt.track.overwriteClip(placeItem, ticksToSec(startTicks));
      }
    } catch (e2) { err = String(e2); }
    if (touchedRange) { try { placeItem.clearInPoint(); placeItem.clearOutPoint(); } catch (e3) {} }
    if (err) fail("PLACE_FAILED", "Premiere rejected the edit for '" + it.name + "': " + err);
    var tol = frameTicks(seq) / 2 + 2;
    var host = vt || at;
    placed = findPlacedClip(host.track, startTicks, placeItem.nodeId, tol);
    if (!placed) fail("PLACE_UNVERIFIED", "Edit ran but no clip was found at " + r3(ticksToSec(startTicks)) + "s on " + host.label + ".");
    // Duration for stills / explicit end
    var wantEnd = has(spec, "end") ? spec.end : (has(spec, "duration") && !has(spec, "in") && !has(spec, "out") ? (spec.start || 0) + spec.duration : null);
    if (wantEnd !== null) {
      try { placed.end = seqTime(seq, wantEnd); } catch (e4) {}
      placed = findPlacedClip(host.track, startTicks, placeItem.nodeId, tol) || placed;
    }
    if (spec.name) { try { placed.name = spec.name; } catch (e5) {} }
    else if (placeItem !== it) { try { placed.name = it.name; } catch (e5b) {} }
    if (has(spec, "enabled")) try { placed.disabled = !spec.enabled; } catch (e6) {}
    var entry = { clip: placed, track: host.label, index: 0, trackObj: host.track, video: host.video };
    var extras = [];
    if (spec.transform) extras.push(applyTransform(seq, entry, spec.transform));
    if (spec.effects) extras.push(applyEffectsTo(seq, [entry], asArray(spec.effects)));
    if (spec.properties) for (var p = 0; p < spec.properties.length; p++) setPropsOn(seq, entry, spec.properties[p]);
    if (spec.keyframes) for (var k = 0; k < spec.keyframes.length; k++) addKeysOn(entry, spec.keyframes[k]);
    if (spec.volume_db !== undefined) setVolumeOn(entry, spec.volume_db);
    var info = clipInfo(placed, host.label, -1, { media: true });
    delete info.index;
    if (media === "video" && placeItem !== it) info.videoOnly = true;
    return info;
  }

  H.place_clips = function (a) {
    var s = getSequence(a.sequence);
    var clips = asArray(a.clips), placed = [], errors = [];
    for (var i = 0; i < clips.length; i++) {
      try { placed.push(placeOne(s, clips[i], a)); }
      catch (e) {
        errors.push({ index: i, item: clips[i].item, error: e && e.message ? e.message : String(e), code: e && e.code });
        if (a.stop_on_error) break;
      }
    }
    return { placed: placed, errors: errors, sequence: s.name };
  };

  H.import_mogrt = function (a) {
    var s = getSequence(a.sequence);
    var f = new File(a.path);
    if (!f.exists) fail("FILE_NOT_FOUND", "MOGRT not found: " + a.path);
    var t = parseTrackRef(a.track || "V1");
    if (t.video) getTrack(s, a.track || "V1", true);
    var aIdx = has(a, "audio_track") ? parseTrackRef(a.audio_track).index : 0;
    var clip = s.importMGT(f.fsName, String(snapTicks(s, secToTicks(a.start || 0))), t.index, aIdx);
    if (!clip) fail("MOGRT_FAILED", "Premiere did not import the MOGRT.");
    if (has(a, "duration")) try { clip.end = seqTime(s, (a.start || 0) + a.duration); } catch (e) {}
    var entry = { clip: clip, track: trackLabel(true, t.index), video: true };
    var setRes = null;
    if (a.params) setRes = setMogrtParams(clip, a.params);
    var info = clipInfo(clip, entry.track, -1, {});
    info.params = listMogrtParams(clip);
    if (setRes) info.set = setRes;
    return info;
  };
  function mgtComp(clip) {
    var c = null;
    try { c = clip.getMGTComponent(); } catch (e) {}
    if (!c) fail("NOT_MOGRT", "Clip '" + clip.name + "' is not a Motion Graphics Template.");
    return c;
  }
  function listMogrtParams(clip) {
    var c = mgtComp(clip), out = [];
    for (var i = 0; i < c.properties.numItems; i++) {
      var p = c.properties[i], v = null;
      try { v = p.getValue(); } catch (e) {}
      var d = { name: p.displayName };
      if (typeof v === "string" && v.indexOf("textEditValue") >= 0) { try { d.text = parse(v).textEditValue; d.kind = "text"; } catch (e2) { d.value = v; } }
      else d.value = v;
      out.push(d);
    }
    return out;
  }
  function setMogrtParams(clip, params) {
    var c = mgtComp(clip), done = [], missing = [];
    for (var k in params) {
      if (!params.hasOwnProperty(k)) continue;
      var p = findProp(c, k);
      if (!p) { missing.push(k); continue; }
      var cur = null;
      try { cur = p.getValue(); } catch (e) {}
      var val = params[k];
      if (typeof cur === "string" && cur.indexOf("textEditValue") >= 0) {
        var obj = parse(cur);
        obj.textEditValue = String(val);
        p.setValue(stringify(obj), true);
      } else if (typeof val === "string" && /^#[0-9a-fA-F]{6}$/.test(val)) {
        applyValue(p, val);
      } else p.setValue(val, true);
      done.push(k);
    }
    return { set: done, missing: missing };
  }
  H.set_mogrt_params = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) out.push({ id: String(list[i].clip.nodeId), result: setMogrtParams(list[i].clip, a.params) });
    return { clips: out };
  };
  H.get_mogrt_params = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) out.push({ id: String(list[i].clip.nodeId), params: listMogrtParams(list[i].clip) });
    return { clips: out };
  };

  // ---- clip edits
  H.move_clips = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    // Move later clips first when shifting right so they never collide.
    var delta = has(a, "delta") ? a.delta : null;
    if (delta !== null && delta > 0) list.sort(function (x, y) { return tsec(y.clip.start) - tsec(x.clip.start); });
    for (var i = 0; i < list.length; i++) {
      var c = list[i].clip, d = delta;
      if (d === null) { if (!has(a, "to")) fail("BAD_ARGS", "Pass delta or to"); d = a.to - tsec(c.start); }
      c.move(timeFromTicks(snapTicks(s, secToTicks(d))));
      out.push({ id: String(c.nodeId), start: r3(tsec(c.start)), end: r3(tsec(c.end)) });
    }
    return { moved: out };
  };
  H.move_clip_to_track = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i], dest = parseTrackRef(a.track);
      if (dest.video !== e.video) fail("BAD_ARGS", "Cannot move between video and audio tracks.");
      getTrack(s, a.track, a.auto_create_tracks !== false);
      var cur = parseTrackRef(e.track).index;
      var qc = qeClipFor(s, e);
      var dv = e.video ? dest.index - cur : 0, da = e.video ? 0 : dest.index - cur;
      qc.moveToTrack(dv, da, "0", false);
      out.push({ id: String(e.clip.nodeId), track: a.track });
    }
    return { moved: out };
  };
  H.trim_clips = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i].clip;
      if (has(a, "in")) c.inPoint = timeFromSec(a["in"]);
      if (has(a, "out")) c.outPoint = timeFromSec(a.out);
      if (has(a, "start")) c.start = seqTime(s, a.start);
      if (has(a, "end")) c.end = seqTime(s, a.end);
      if (has(a, "duration")) c.end = seqTime(s, tsec(c.start) + a.duration);
      if (has(a, "trim_start")) { c.start = seqTime(s, tsec(c.start) + a.trim_start); }
      if (has(a, "trim_end")) { c.end = seqTime(s, tsec(c.end) - a.trim_end); }
      out.push(clipInfo(c, list[i].track, list[i].index, {}));
    }
    return { clips: out };
  };
  H.remove_clips = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    // remove from the end backwards so indices / ripples stay valid
    list.sort(function (x, y) { return tsec(y.clip.start) - tsec(x.clip.start); });
    for (var i = 0; i < list.length; i++) { out.push({ id: String(list[i].clip.nodeId), name: list[i].clip.name, track: list[i].track }); list[i].clip.remove(!!a.ripple, a.align_to_video !== false); }
    return { removed: out };
  };
  H.set_clips = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i].clip;
      if (has(a, "enabled")) c.disabled = !a.enabled;
      if (has(a, "name")) c.name = a.name;
      if (has(a, "label")) try { c.setColorLabel(a.label); } catch (e) {}
      if (has(a, "selected")) c.setSelected(!!a.selected, true);
      out.push(clipInfo(c, list[i].track, list[i].index, {}));
    }
    return { clips: out };
  };
  H.select_clips = function (a) {
    var s = getSequence(a.sequence);
    if (a.deselect_others !== false) { var all = selectClips(s, {}); for (var j = 0; j < all.length; j++) try { all[j].clip.setSelected(false, true); } catch (e) {} }
    var list = selectClips(s, a.clips || {}), ids = [];
    for (var i = 0; i < list.length; i++) { list[i].clip.setSelected(true, true); ids.push(String(list[i].clip.nodeId)); }
    return { selected: ids.length, ids: ids };
  };
  H.get_selection = function (a) {
    var s = getSequence(a.sequence), list = selectClips(s, { selected: true }), out = [];
    for (var i = 0; i < list.length; i++) out.push(clipInfo(list[i].clip, list[i].track, list[i].index, { media: true }));
    return { clips: out };
  };
  H.find_clips = function (a) {
    var s = getSequence(a.sequence), list = selectClips(s, a.clips || {}), out = [];
    for (var i = 0; i < list.length; i++) out.push(clipInfo(list[i].clip, list[i].track, list[i].index, { media: true, effects: true }));
    return { clips: out, count: out.length };
  };
  H.link_clips = function (a) {
    var s = getSequence(a.sequence);
    H.select_clips({ sequence: a.sequence, clips: a.clips });
    var ok = a.unlink ? s.unlinkSelection() : s.linkSelection();
    return { linked: !a.unlink, ok: !!ok };
  };
  H.razor = function (a) {
    var s = getSequence(a.sequence), qs = qeSequenceFor(s);
    var times = asArray(a.times), tracks = a.tracks ? asArray(a.tracks) : null, cuts = 0;
    for (var i = 0; i < times.length; i++) {
      var tc = timecodeFor(s, snapTicks(s, secToTicks(times[i])));
      if (!tracks) { qs.razor(tc, true, true); cuts++; continue; }
      for (var j = 0; j < tracks.length; j++) {
        var t = parseTrackRef(tracks[j]);
        var qt = t.video ? qs.getVideoTrackAt(t.index) : qs.getAudioTrackAt(t.index);
        qt.razor(tc, true, true);
        cuts++;
      }
    }
    return { cuts: cuts, times: times };
  };
  H.set_speed = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i], qc = qeClipFor(s, e);
      qc.setSpeed(a.speed, "", !!a.reverse, !!a.ripple, !!a.maintain_pitch);
      var fresh = findPlacedClip(e.trackObj, parseFloat(e.clip.start.ticks), null, 2) || e.clip;
      var sp = null;
      try { sp = fresh.getSpeed(); } catch (ee) {}
      out.push({ id: String(fresh.nodeId), speed: sp, end: r3(tsec(fresh.end)) });
    }
    return { clips: out };
  };
  H.close_gaps = function (a) {
    var s = getSequence(a.sequence), tracks = asArray(a.tracks || a.track), moved = 0;
    for (var t = 0; t < tracks.length; t++) {
      var tr = getTrack(s, tracks[t], false).track, cursor = has(a, "from") ? a.from : 0;
      var items = [];
      for (var i = 0; i < tr.clips.numItems; i++) items.push(tr.clips[i]);
      items.sort(function (x, y) { return tsec(x.start) - tsec(y.start); });
      for (var k = 0; k < items.length; k++) {
        var c = items[k], st = tsec(c.start);
        if (st < cursor - 0.0005) { cursor = tsec(c.end); continue; }
        var gap = st - cursor;
        if (gap > 0.0005) { c.move(timeFromTicks(-snapTicks(s, secToTicks(gap)))); moved++; }
        cursor = tsec(c.end);
      }
    }
    return { closedGaps: moved };
  };

  // ---- effects
  H.list_available_effects = function (a) {
    var kinds = a.kind ? [a.kind] : ["video", "audio", "video_transition", "audio_transition"], out = {};
    var re = a.filter ? new RegExp(a.filter, "i") : null;
    for (var i = 0; i < kinds.length; i++) {
      var list = catalog(kinds[i]), f = [];
      for (var j = 0; j < list.length; j++) if (!re || re.test(list[j])) f.push(list[j]);
      out[kinds[i]] = f;
    }
    return out;
  };
  H.get_clip_effects = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length && i < (a.limit || 20); i++) {
      var c = list[i].clip, comps = [];
      var base = null;
      try { base = keyBase(c); } catch (e) {}
      for (var k = 0; k < c.components.numItems; k++) {
        var comp = c.components[k], d = { index: k, name: comp.displayName, matchName: comp.matchName };
        if (a.include_values !== false) {
          d.props = [];
          for (var p = 0; p < comp.properties.numItems; p++) {
            var pr = comp.properties[p], pd = { name: pr.displayName, value: readValue(pr) };
            try {
              if (pr.isTimeVarying()) {
                var keys = pr.getKeys(), kl = [];
                if (keys && keys.length) for (var q = 0; q < keys.length && q < 50; q++) { var kv = null; try { kv = pr.getValueAtKey(keys[q]); } catch (ee) {} kl.push({ t: base ? keyClipSeconds(base, keys[q]) : r3(tsec(keys[q])), v: kv }); }
                pd.keyframes = kl;
              }
            } catch (e2) {}
            d.props.push(pd);
          }
        }
        comps.push(d);
      }
      out.push({ id: String(c.nodeId), name: c.name, track: list[i].track, components: comps });
    }
    return { clips: out };
  };
  function applyEffectsTo(seq, list, effects) {
    var results = [];
    for (var e = 0; e < effects.length; e++) {
      var spec = typeof effects[e] === "string" ? { name: effects[e] } : effects[e];
      for (var i = 0; i < list.length; i++) {
        var entry = list[i], kind = entry.video ? "video" : "audio";
        var name = resolveCatalogName(kind, spec.name);
        var obj = qeObject(kind, name);
        var qc = qeClipFor(seq, entry);
        var before = entry.clip.components.numItems;
        if (entry.video) qc.addVideoEffect(obj); else qc.addAudioEffect(obj);
        var after = entry.clip.components.numItems;
        var r = { id: String(entry.clip.nodeId), effect: name, added: after > before };
        if (after > before && spec.params) {
          var comp = entry.clip.components[after - 1], set = [];
          for (var k in spec.params) if (spec.params.hasOwnProperty(k)) { var pr = requireProp(comp, k); applyValue(pr, spec.params[k]); set.push(k); }
          r.set = set;
        }
        results.push(r);
      }
    }
    return results;
  }
  H.apply_effects = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips);
    var res = applyEffectsTo(s, list, asArray(a.effects));
    var failed = 0;
    for (var i = 0; i < res.length; i++) if (!res[i].added) failed++;
    return { results: res, applied: res.length - failed, failed: failed };
  };
  H.remove_effects = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    var names = a.effects ? asArray(a.effects) : null;
    for (var i = 0; i < list.length; i++) {
      var e = list[i], qc = qeClipFor(s, e), removed = [];
      var n = qc.numComponents;
      for (var k = n - 1; k >= 0; k--) {
        var dom = e.clip.components[k];
        if (!dom || isBuiltIn(dom)) continue;
        var match = !names;
        if (names) for (var m = 0; m < names.length; m++) if (dom.displayName === names[m] || dom.matchName === names[m] || normName(dom.displayName) === normName(names[m])) match = true;
        if (!match) continue;
        var qcomp = qc.getComponentAt(k);
        if (qcomp && typeof qcomp.remove === "function") { qcomp.remove(); removed.push(dom.displayName); }
      }
      out.push({ id: String(e.clip.nodeId), removed: removed });
    }
    return { clips: out };
  };
  function setPropsOn(seq, entry, spec) {
    var comp = requireComponent(entry.clip, spec.effect || "Motion");
    var p = requireProp(comp, spec.property);
    var v = spec.value;
    if (spec.unit === "px" && v instanceof Array) { var fsz = frameSize(seq); v = [v[0] / fsz.w, v[1] / fsz.h]; }
    if (has(spec, "time")) {
      var base = keyBase(entry.clip);
      if (!p.isTimeVarying()) p.setTimeVarying(true);
      var t = keyTime(base, spec.time);
      p.addKey(t);
      applyValueAtKey(p, t, v);
    } else applyValue(p, v);
    return { effect: comp.displayName, property: p.displayName, value: readValue(p) };
  }
  H.set_properties = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [], errors = [];
    var sets = asArray(a.set);
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < sets.length; j++) {
        try { var r = setPropsOn(s, list[i], sets[j]); r.id = String(list[i].clip.nodeId); out.push(r); }
        catch (e) { errors.push({ id: String(list[i].clip.nodeId), error: e.message || String(e) }); }
      }
    }
    return { set: out, errors: errors };
  };
  // Friendly transform: scale %, position px (or normalized with unit "norm"), rotation deg, anchor px, opacity %, crop %.
  function applyTransform(seq, entry, tr) {
    var c = entry.clip, done = {};
    if (!entry.video) fail("BAD_ARGS", "Transform needs a video clip");
    var motion = requireComponent(c, "AE.ADBE Motion");
    var fsz = frameSize(seq);
    function pos(v) { if (!(v instanceof Array)) fail("BAD_VALUE", "position must be [x, y]"); return tr.unit === "norm" ? v : [v[0] / fsz.w, v[1] / fsz.h]; }
    if (has(tr, "scale")) { applyValue(findProp(motion, "scale"), tr.scale); done.scale = tr.scale; }
    if (has(tr, "scale_width")) { var u = findProp(motion, "uniformscale"); try { applyValue(u, false); } catch (e) {} applyValue(findProp(motion, "scalewidth"), tr.scale_width); done.scale_width = tr.scale_width; }
    if (has(tr, "position")) { applyValue(findProp(motion, "position"), pos(tr.position)); done.position = tr.position; }
    if (has(tr, "rotation")) { applyValue(findProp(motion, "rotation"), tr.rotation); done.rotation = tr.rotation; }
    if (has(tr, "anchor")) { applyValue(findProp(motion, "anchor"), pos(tr.anchor)); done.anchor = tr.anchor; }
    var crops = ["crop_left", "crop_top", "crop_right", "crop_bottom"], ck = ["cropleft", "croptop", "cropright", "cropbottom"];
    for (var i = 0; i < crops.length; i++) if (has(tr, crops[i])) {
      var cp = findProp(motion, ck[i]);
      if (!cp) fail("UNSUPPORTED", "This Premiere build has no Motion crop properties; use apply_effects Crop.");
      applyValue(cp, tr[crops[i]]); done[crops[i]] = tr[crops[i]];
    }
    if (has(tr, "opacity")) { var op = requireComponent(c, "AE.ADBE Opacity"); applyValue(op.properties[0], tr.opacity); done.opacity = tr.opacity; }
    if (has(tr, "blend_mode")) { var op2 = requireComponent(c, "AE.ADBE Opacity"); if (op2.properties.numItems > 1) { applyValue(op2.properties[1], tr.blend_mode); done.blend_mode = tr.blend_mode; } }
    return done;
  }
  H.set_transform = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [], errors = [];
    for (var i = 0; i < list.length; i++) {
      try { out.push({ id: String(list[i].clip.nodeId), set: applyTransform(s, list[i], a) }); }
      catch (e) { errors.push({ id: String(list[i].clip.nodeId), error: e.message || String(e) }); }
    }
    return { clips: out, errors: errors };
  };

  function addKeysOn(entry, spec) {
    var c = entry.clip, comp = requireComponent(c, spec.effect || "Motion"), p = requireProp(comp, spec.property);
    if (p.areKeyframesSupported && !p.areKeyframesSupported()) fail("UNSUPPORTED", p.displayName + " cannot be keyframed");
    var base = keyBase(c), seq = null;
    if (spec.replace && p.isTimeVarying()) { p.setTimeVarying(false); }
    if (!p.isTimeVarying()) p.setTimeVarying(true);
    var keys = asArray(spec.keys), done = 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var tClip = has(k, "t") ? k.t : 0;
      if (k.from === "end" || (typeof k.t === "string" && k.t === "end")) tClip = base.dur - (typeof k.offset === "number" ? k.offset : 0);
      if (spec.time_base === "sequence") tClip = tClip - base.start;
      if (tClip < 0) tClip = 0;
      if (tClip > base.dur) tClip = base.dur;
      var t = keyTime(base, tClip);
      var v = k.v;
      if (spec.unit === "px" && v instanceof Array) { if (!seq) seq = app.project.activeSequence; var fsz = frameSize(seq); v = [v[0] / fsz.w, v[1] / fsz.h]; }
      p.addKey(t);
      applyValueAtKey(p, t, v);
      var interp = k.interp || spec.interp;
      if (interp && INTERP[interp] !== undefined) try { p.setInterpolationTypeAtKey(t, INTERP[interp], true); } catch (e) {}
      done++;
    }
    return { id: String(c.nodeId), effect: comp.displayName, property: p.displayName, keys: done };
  }
  H.add_keyframes = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [], errors = [];
    var anims = asArray(a.animations || a);
    for (var i = 0; i < list.length; i++) for (var j = 0; j < anims.length; j++) {
      try { out.push(addKeysOn(list[i], anims[j])); } catch (e) { errors.push({ id: String(list[i].clip.nodeId), error: e.message || String(e) }); }
    }
    return { results: out, errors: errors };
  };
  H.remove_keyframes = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i].clip, comp = requireComponent(c, a.effect || "Motion"), p = requireProp(comp, a.property);
      if (has(a, "from") || has(a, "to")) {
        var base = keyBase(c);
        p.removeKeyRange(keyTime(base, a.from || 0), keyTime(base, has(a, "to") ? a.to : base.dur), true);
      } else p.setTimeVarying(false);
      out.push({ id: String(c.nodeId), property: p.displayName, animated: !!p.isTimeVarying() });
    }
    return { clips: out };
  };
  H.copy_effects = function (a) {
    var s = getSequence(a.sequence);
    var src = findClip(s, a.from);
    if (!src) fail("CLIP_NOT_FOUND", "Source clip not found: " + a.from);
    var targets = requireClips(s, a.to), out = [];
    var srcBase = keyBase(src.clip);
    for (var t = 0; t < targets.length; t++) {
      var dst = targets[t], copied = [];
      if (dst.video !== src.video) continue;
      var dBase = keyBase(dst.clip);
      for (var k = 0; k < src.clip.components.numItems; k++) {
        var sc = src.clip.components[k], dc;
        var builtIn = isBuiltIn(sc);
        if (builtIn) { if (a.include_motion === false) continue; dc = findComponent(dst.clip, sc.matchName); if (!dc) continue; }
        else {
          var kind = src.video ? "video" : "audio";
          var name = resolveCatalogName(kind, sc.displayName);
          var before = dst.clip.components.numItems;
          var qc = qeClipFor(s, dst);
          if (src.video) qc.addVideoEffect(qeObject(kind, name)); else qc.addAudioEffect(qeObject(kind, name));
          if (dst.clip.components.numItems <= before) continue;
          dc = dst.clip.components[dst.clip.components.numItems - 1];
        }
        copyComponentValues(sc, dc, srcBase, dBase, a.keyframe_mode || "relative");
        copied.push(sc.displayName);
      }
      out.push({ id: String(dst.clip.nodeId), copied: copied });
    }
    return { clips: out };
  };
  function copyComponentValues(sc, dc, sBase, dBase, mode) {
    var n = Math.min(sc.properties.numItems, dc.properties.numItems);
    for (var i = 0; i < n; i++) {
      var sp = sc.properties[i], dp = dc.properties[i];
      try {
        if (sp.isTimeVarying()) {
          var keys = sp.getKeys();
          if (dp.isTimeVarying()) dp.setTimeVarying(false);
          dp.setTimeVarying(true);
          for (var k = 0; keys && k < keys.length; k++) {
            var off = keyClipSeconds(sBase, keys[k]);
            if (mode === "stretch" && sBase.dur > 0) off = off * dBase.dur / sBase.dur;
            var t = keyTime(dBase, off);
            dp.addKey(t);
            dp.setValueAtKey(t, sp.getValueAtKey(keys[k]), true);
          }
        } else {
          if (dp.isTimeVarying()) dp.setTimeVarying(false);
          var v = sp.getValue();
          if (v !== undefined && v !== null) dp.setValue(v, true);
        }
      } catch (e) {}
    }
  }

  // Effect preset spec produced by the Node side from the .prfpset XML.
  H.apply_effect_spec = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    var effects = asArray(a.effects);
    for (var i = 0; i < list.length; i++) {
      var entry = list[i], base = keyBase(entry.clip), done = [], errs = [];
      for (var e = 0; e < effects.length; e++) {
        var fx = effects[e];
        try {
          var comp = null;
          if (fx.intrinsic) comp = findComponent(entry.clip, fx.matchName);
          if (!comp) {
            var kind = entry.video ? "video" : "audio";
            var name = resolveCatalogName(kind, fx.displayName || fx.matchName);
            var before = entry.clip.components.numItems;
            var qc = qeClipFor(s, entry);
            if (entry.video) qc.addVideoEffect(qeObject(kind, name)); else qc.addAudioEffect(qeObject(kind, name));
            if (entry.clip.components.numItems <= before) throw new Error("Premiere did not add " + name);
            comp = entry.clip.components[entry.clip.components.numItems - 1];
          }
          var params = fx.params || [], setCount = 0;
          for (var p = 0; p < params.length; p++) {
            var pp = params[p];
            var prop = has(pp, "index") && pp.index < comp.properties.numItems ? comp.properties[pp.index] : null;
            if (prop && pp.name && normName(prop.displayName) !== normName(pp.name)) { var byName = findProp(comp, pp.name); if (byName) prop = byName; }
            if (!prop) continue;
            try {
              if (pp.keys && pp.keys.length) {
                if (prop.isTimeVarying()) prop.setTimeVarying(false);
                prop.setTimeVarying(true);
                for (var k = 0; k < pp.keys.length; k++) {
                  var kk = pp.keys[k], off;
                  if (fx.anchor === "out") off = base.dur - kk.fromEnd;
                  else if (fx.anchor === "scale" && kk.frac !== undefined) off = kk.frac * base.dur;
                  else off = kk.fromStart;
                  if (off < 0) off = 0; if (off > base.dur) off = base.dur;
                  var t = keyTime(base, off);
                  prop.addKey(t);
                  prop.setValueAtKey(t, kk.v, true);
                  if (kk.interp !== undefined) try { prop.setInterpolationTypeAtKey(t, kk.interp, true); } catch (ie) {}
                }
                setCount++;
              } else if (pp.v !== undefined && pp.v !== null) {
                if (prop.isTimeVarying()) prop.setTimeVarying(false);
                prop.setValue(pp.v, true);
                setCount++;
              }
            } catch (pe) {}
          }
          done.push({ effect: comp.displayName, params: setCount });
        } catch (ex) { errs.push((fx.displayName || fx.matchName) + ": " + (ex.message || String(ex))); }
      }
      out.push({ id: String(entry.clip.nodeId), applied: done, errors: errs });
    }
    return { clips: out };
  };

  // ---- transitions
  H.add_transitions = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    var where = a.position || "start";
    var fr = fps(s), frames = Math.max(1, Math.round((a.duration || 0.5) * fr));
    var nominal = Math.round(fr);
    var tc = pad2(Math.floor(frames / (nominal * 3600))) + ":" + pad2(Math.floor(frames / (nominal * 60)) % 60) + ":" + pad2(Math.floor(frames / nominal) % 60) + ":" + pad2(frames % nominal);
    for (var i = 0; i < list.length; i++) {
      var e = list[i], kind = e.video ? "video_transition" : "audio_transition";
      var name = resolveCatalogName(kind, a.name || (e.video ? "Cross Dissolve" : "Constant Power"));
      var obj = qeObject(kind, name), qc = qeClipFor(s, e);
      var before = e.trackObj.transitions ? e.trackObj.transitions.numItems : 0;
      var align = a.alignment === "center" ? 0.5 : a.alignment === "end" ? 1 : a.alignment === "start" ? 0 : 0.5;
      if (where === "start" || where === "both") qc.addTransition(obj, true, tc, "0", align, !!a.single_sided, true);
      if (where === "end" || where === "both") qc.addTransition(obj, false, tc, "0", align, !!a.single_sided, true);
      var after = e.trackObj.transitions ? e.trackObj.transitions.numItems : 0;
      out.push({ id: String(e.clip.nodeId), transition: name, added: after - before });
    }
    return { results: out };
  };

  // ---- audio
  function dbToLevel(db) { return Math.pow(10, (db - 15) / 20); }
  function levelToDb(v) { return v > 0 ? r3(20 * Math.log(v) / Math.LN10 + 15) : -Infinity; }
  function volumeProp(clip) {
    var comp = null;
    for (var i = 0; i < clip.components.numItems; i++) if (/^Internal Volume/.test(String(clip.components[i].matchName))) { comp = clip.components[i]; break; }
    if (!comp) comp = findComponent(clip, "Volume");
    if (!comp) fail("NO_VOLUME", "Clip '" + clip.name + "' has no Volume component (is it an audio clip?)");
    return comp.properties.numItems > 1 ? comp.properties[1] : comp.properties[0];
  }
  function setVolumeOn(entry, db) {
    var p = volumeProp(entry.clip);
    if (p.isTimeVarying()) p.setTimeVarying(false);
    p.setValue(dbToLevel(db), true);
  }
  H.set_volume = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.video) continue;
      var p = volumeProp(e.clip);
      if (a.keys) {
        var base = keyBase(e.clip);
        if (p.isTimeVarying()) p.setTimeVarying(false);
        p.setTimeVarying(true);
        for (var k = 0; k < a.keys.length; k++) {
          var t = keyTime(base, Math.max(0, Math.min(base.dur, a.keys[k].t)));
          p.addKey(t); p.setValueAtKey(t, dbToLevel(a.keys[k].db), true);
        }
      } else setVolumeOn(e, a.db);
      out.push({ id: String(e.clip.nodeId), db: p.isTimeVarying() ? "keyed" : levelToDb(p.getValue()) });
    }
    return { clips: out };
  };
  H.fade_audio = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.video) continue;
      var p = volumeProp(e.clip), base = keyBase(e.clip);
      var cur = p.isTimeVarying() ? dbToLevel(has(a, "level_db") ? a.level_db : 0) : p.getValue();
      if (has(a, "level_db")) cur = dbToLevel(a.level_db);
      if (p.isTimeVarying()) p.setTimeVarying(false);
      p.setTimeVarying(true);
      var floor = dbToLevel(-96);
      var pts = [];
      if (a.fade_in) { pts.push([0, floor]); pts.push([a.fade_in, cur]); }
      if (a.fade_out) { pts.push([base.dur - a.fade_out, cur]); pts.push([base.dur, floor]); }
      for (var q = 0; q < pts.length; q++) {
        var kt = keyTime(base, Math.max(0, Math.min(base.dur, pts[q][0])));
        p.addKey(kt); p.setValueAtKey(kt, pts[q][1], true);
      }
      out.push({ id: String(e.clip.nodeId), fadeIn: a.fade_in || 0, fadeOut: a.fade_out || 0 });
    }
    return { clips: out };
  };

  // ---- markers
  function markerInfo(m) {
    var d = { start: r3(tsec(m.start)), end: r3(tsec(m.end)), name: m.name, comment: m.comments, type: m.type };
    try { d.color = m.getColorByIndex(); } catch (e) {}
    try { d.guid = m.guid; } catch (e2) {}
    return d;
  }
  function markerCollection(a) {
    if (a.item) { var it = resolveItem(a.item); return it.getMarkers(); }
    return getSequence(a.sequence).markers;
  }
  H.list_markers = function (a) {
    var ms = markerCollection(a), out = [];
    var m = ms.getFirstMarker();
    while (m) { out.push(markerInfo(m)); m = ms.getNextMarker(m); }
    return { markers: out };
  };
  H.add_markers = function (a) {
    var ms = markerCollection(a), out = [], list = asArray(a.markers);
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var m = ms.createMarker(d.time);
      if (d.name) m.name = d.name;
      if (d.comment) m.comments = d.comment;
      if (has(d, "duration") && d.duration > 0) m.end = d.time + d.duration; // marker.end takes seconds, not a Time
      if (has(d, "color")) try { m.setColorByIndex(d.color); } catch (e) {}
      if (d.type === "chapter") m.setTypeAsChapter(); else if (d.type === "segmentation") m.setTypeAsSegmentation(); else if (d.type === "web") m.setTypeAsWebLink(d.url || "", ""); else if (d.type === "comment") m.setTypeAsComment();
      out.push(markerInfo(m));
    }
    return { added: out };
  };
  H.delete_markers = function (a) {
    var ms = markerCollection(a), removed = 0, all = [];
    var m = ms.getFirstMarker();
    while (m) { all.push(m); m = ms.getNextMarker(m); }
    var re = a.name_regex ? new RegExp(a.name_regex, "i") : null;
    for (var i = 0; i < all.length; i++) {
      var st = tsec(all[i].start);
      if (has(a, "time") && Math.abs(st - a.time) > 0.02) continue;
      if (re && !re.test(all[i].name)) continue;
      if (has(a, "from") && st < a.from) continue;
      if (has(a, "to") && st > a.to) continue;
      ms.deleteMarker(all[i]);
      removed++;
    }
    return { removed: removed };
  };

  // ---- export & interchange
  H.export_frame = function (a) {
    var s = getSequence(a.sequence);
    var times = asArray(has(a, "times") ? a.times : (has(a, "time") ? a.time : tsec(s.getPlayerPosition())));
    var qs = qeSequenceFor(s), folder = new Folder(a.folder);
    if (!folder.exists) folder.create();
    var out = [], errors = [];
    var pngPreset = a.png_preset ? new File(a.png_preset) : null;
    // Saved sequence in/out, restored after method 2 (seconds; <= -399999 means "not set").
    var savedIn = null, savedOut = null;
    try { savedIn = parseFloat(s.getInPointAsTime().seconds); savedOut = parseFloat(s.getOutPointAsTime().seconds); } catch (eS) {}
    var touchedRange = false;
    for (var i = 0; i < times.length; i++) {
      var ticks = snapTicks(s, secToTicks(times[i]));
      var tc = timecodeFor(s, ticks);
      var base = folder.fsName + "\\mcpframe_" + new Date().getTime() + "_" + i;
      var f = new File(base + ".png"), method = null;
      if (f.exists) f.remove();
      // Method 1: QE still export (fast; broken on some 26.x hosts).
      try { qs.exportFramePNG(tc, base); } catch (e) { errors.push("qe: " + e); }
      for (var w = 0; w < 30 && !(f.exists && f.length > 0); w++) $.sleep(50);
      if (f.exists && f.length > 0) method = "qe";
      // Method 2: one-frame direct export with the PNG preset.
      if (!method && pngPreset && pngPreset.exists) {
        try {
          s.setInPoint(ticksToSec(ticks));
          s.setOutPoint(ticksToSec(ticks + frameTicks(s)));
          touchedRange = true;
          var r = s.exportAsMediaDirect(f.fsName, pngPreset.fsName, 1);
          if (r && /error/i.test(String(r))) errors.push("direct: " + r);
          // PNG "sequence" exports may append a frame number.
          var alt = new Folder(folder.fsName).getFiles(decodeURI(new File(base).name) + "*.png");
          if (!(f.exists && f.length > 0) && alt.length) { alt[0].rename(decodeURI(f.name)); f = new File(base + ".png"); }
          if (f.exists && f.length > 0) method = "direct";
        } catch (e2) { errors.push("direct: " + e2); }
      }
      out.push({ time: r3(ticksToSec(ticks)), timecode: tc, path: method ? f.fsName : null, method: method });
    }
    if (touchedRange) {
      try { if (savedIn !== null && savedIn > -399999) s.setInPoint(savedIn); if (savedOut !== null && savedOut > -399999) s.setOutPoint(savedOut); } catch (eR) {}
    }
    var res = { frames: out };
    var failed = 0;
    for (var k = 0; k < out.length; k++) if (!out[k].path) failed++;
    if (failed) {
      res.errors = errors.slice(0, 6);
      res.hint = "Premiere refused to render stills. Bring the Premiere window to the front (not minimized / not covered), make sure the sequence is open in the Timeline and Program Monitor, then retry.";
    }
    return res;
  };
  H.export_fcp_xml = function (a) {
    var s = getSequence(a.sequence);
    var f = new File(a.path);
    s.exportAsFinalCutProXML(f.fsName, 1); // 1 = suppress the Translation Report dialog
    return { path: f.fsName, exists: new File(f.fsName).exists };
  };
  H.export_edl = function (a) {
    var s = getSequence(a.sequence);
    if (typeof s.exportAsEDL !== "function") fail("UNSUPPORTED", "exportAsEDL is not available on this build");
    s.exportAsEDL(a.path, a.preset_path || "");
    return { path: a.path, exists: new File(a.path).exists };
  };
  H.export_aaf = function (a) {
    var s = getSequence(a.sequence);
    var ok = app.project.exportAAF(s, a.path, a.mixdown_video ? 1 : 0, a.explode_to_mono ? 1 : 0, a.sample_rate || 48000, a.bits || 16, a.embed_audio ? 1 : 0, 0, a.trim_sources ? 1 : 0, a.handle_frames || 0);
    return { path: a.path, ok: !!ok, exists: new File(a.path).exists };
  };
  H.export_media = function (a) {
    var s = getSequence(a.sequence);
    var range = a.range === "in_out" ? 1 : a.range === "work_area" ? 2 : 0;
    var preset = new File(a.preset_path);
    if (!preset.exists) fail("FILE_NOT_FOUND", "Export preset not found: " + a.preset_path, "Use list_export_presets.");
    if (a.use_media_encoder) {
      try { app.encoder.launchEncoder(); } catch (e) {}
      var jobId = app.encoder.encodeSequence(s, a.path, preset.fsName, range, a.remove_on_completion ? 1 : 0);
      if (a.start_queue !== false) try { app.encoder.startBatch(); } catch (e2) {}
      return { queued: true, jobId: jobId, path: a.path, encoder: "Adobe Media Encoder" };
    }
    var r = s.exportAsMediaDirect(a.path, preset.fsName, range);
    return { done: true, path: a.path, exists: new File(a.path).exists, result: r };
  };
  H.import_captions = function (a) {
    var s = getSequence(a.sequence);
    var imp = H.import_files({ paths: [a.path], bin: a.bin || "_MCP Plus/Captions" });
    if (!imp.imported.length) fail("IMPORT_FAILED", "Caption file was not imported");
    var item = findItemByNodeId(imp.imported[0].id);
    var fmt = a.format === "open" ? Sequence.CAPTION_FORMAT_OPEN : a.format === "608" ? Sequence.CAPTION_FORMAT_608 : a.format === "708" ? Sequence.CAPTION_FORMAT_708 : Sequence.CAPTION_FORMAT_SUBTITLE;
    var ok = s.createCaptionTrack(item, a.start || 0, fmt);
    return { ok: !!ok, item: imp.imported[0].id };
  };
  H.create_subsequence = function (a) {
    var s = getSequence(a.sequence);
    if (has(a, "in")) s.setInPoint(a["in"]);
    if (has(a, "out")) s.setOutPoint(a.out);
    var sub = s.createSubsequence(!!a.ignore_track_targeting);
    if (!sub) fail("SUBSEQUENCE_FAILED", "Premiere did not create the subsequence");
    if (a.name) sub.name = a.name;
    return summarizeSequence(sub);
  };
  H.auto_reframe = function (a) {
    var s = getSequence(a.sequence);
    var r = s.autoReframeSequence(a.numerator || 9, a.denominator || 16, a.motion_preset || "default", a.name || (s.name + " (reframed)"), a.use_nested_sequences !== false);
    if (!r) fail("REFRAME_FAILED", "Auto Reframe returned nothing.");
    return summarizeSequence(r);
  };
  H.scene_edit_detection = function (a) {
    var s = getSequence(a.sequence);
    H.select_clips({ sequence: a.sequence, clips: a.clips });
    var r = s.performSceneEditDetectionOnSelection(a.action === "cuts" ? "ApplyCuts" : "CreateMarkers", a.apply_to_linked_audio !== false, a.sensitivity === "low" ? "LowSensitivity" : a.sensitivity === "high" ? "HighSensitivity" : "MediumSensitivity");
    return { ok: !!r };
  };

  // ---- undo / misc
  H.undo = function (a) { ensureQE(); var n = a.steps || 1; for (var i = 0; i < n; i++) qe.project.undo(); return { undone: n }; };
  H.redo = function (a) { ensureQE(); var n = a.steps || 1; for (var i = 0; i < n; i++) qe.project.redo(); return { redone: n }; };
  H.eval_script = function (a) {
    var fnBody = String(a.code);
    var f = new Function("H", "helpers", fnBody.indexOf("return") >= 0 ? fnBody : "return (" + fnBody + ");");
    var r = f(H, { getSequence: getSequence, selectClips: selectClips, resolveItem: resolveItem, secToTicks: secToTicks, tsec: tsec });
    return { result: r === undefined ? null : r };
  };
  // Run several handler calls in one round trip; stops at the first failure unless continue_on_error.
  H.batch = function (a) {
    var ops = asArray(a.ops), results = [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!H[op.fn] || op.fn === "batch") { results.push({ ok: false, error: "Unknown op " + op.fn }); if (!a.continue_on_error) break; continue; }
      try { results.push({ ok: true, fn: op.fn, data: H[op.fn](op.args || {}) }); }
      catch (e) { results.push({ ok: false, fn: op.fn, error: e.message || String(e), code: e.code }); if (!a.continue_on_error) break; }
    }
    return { results: results };
  };

  // ================================================================ dispatcher
  $.__mcpPlus = {
    version: LIB_VERSION,
    handlers: H,
    call: function (fn, argsJson) {
      var started = new Date().getTime();
      try {
        if (!H[fn]) return stringify({ ok: false, error: { code: "UNKNOWN_FUNCTION", message: "Unknown host function: " + fn } });
        var args = parse(argsJson);
        var data = H[fn](args || {});
        return stringify({ ok: true, data: data, ms: new Date().getTime() - started });
      } catch (e) {
        var err = e instanceof Fail ? { code: e.code, message: e.message, hint: e.hint } : { code: "HOST_ERROR", message: (e && e.message) ? e.message : String(e), line: e && e.line };
        return stringify({ ok: false, error: err, ms: new Date().getTime() - started });
      }
    }
  };
  return "loaded " + LIB_VERSION;
}());
