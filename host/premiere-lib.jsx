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
  // The project a host call works on, pinned when the call starts: Premiere can
  // move app.project to another open project in the middle of a call (closing
  // every sequence tab of the active project does), and later lookups must not
  // follow it.
  var _pinnedProject = null;
  // app.project always means "the active project"; app.projects[i] objects stay
  // bound to one project, so the pin uses those.
  function stableProject() {
    try {
      if (!app.project || !app.project.rootItem) return null;
      var path = String(app.project.path);
      for (var i = 0; i < app.projects.numProjects; i++) if (String(app.projects[i].path) === path) return app.projects[i];
    } catch (e) {}
    return null;
  }
  function requireProject() {
    if (_pinnedProject) { try { if (_pinnedProject.rootItem) return _pinnedProject; } catch (e) {} }
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
        cur.createBin(name);
        // createBin's return value is not reliable on 26.x (it can point at the
        // parent), so look the new bin up by name.
        for (var j = 0; j < cur.children.numItems; j++) {
          var cc = cur.children[j];
          if (cc && cc.type === 2 && cc.name === name) { next = cc; break; }
        }
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
    var exact = null, byMedia = null, byPath = null, ci = null, helper = null;
    walk(requireProject().rootItem, "", function (it, path) {
      if (it.type === 2) return;
      // Our video-only helper subclips share their source's name and media
      // path; only fall back to them when nothing else matches.
      if (isHelperBin(path)) { if (!helper && (it.name === s || lower(path + "/" + it.name) === wantPath)) helper = it; return; }
      var full = path ? path + "/" + it.name : it.name;
      if (it.name === s && !exact) exact = it;
      if (!byPath && lower(full) === wantPath) byPath = it;
      if (!ci && lower(it.name) === lower(s)) ci = it;
      if (!byMedia) {
        var mp = lower(itemMediaPath(it).replace(/\\/g, "/"));
        if (mp && mp === wantPath) byMedia = it;
      }
    });
    var r = byMedia || byPath || exact || ci || helper;
    if (!r) fail("ITEM_NOT_FOUND", "Project item not found: " + s, "Use list_project_items to get node ids, or import_media first.");
    return r;
  }
  // Bin path ("A/B") of the bin that holds a project item, or "/" for the root.
  function binPathOf(item) {
    var found = null, id = String(item.nodeId);
    walk(requireProject().rootItem, "", function (it, path) { if (String(it.nodeId) === id) { found = path || "/"; return false; } });
    return found;
  }
  function sequenceFps(item) {
    var seqs = allSequences();
    for (var i = 0; i < seqs.length; i++) if (String(seqs[i].projectItem.nodeId) === String(item.nodeId)) return r3(fps(seqs[i]));
    return null;
  }
  function describeItem(it, path, details) {
    var d = { id: String(it.nodeId), name: it.name, type: itemType(it) };
    if (path !== undefined) d.bin = path || "/";
    if (d.type !== "bin") {
      var mp = itemMediaPath(it);
      if (mp) d.media = mp;
      if (details) {
        try { var o = it.getOutPoint(); var inn = it.getInPoint(); d.duration = r3(tsec(o) - tsec(inn)); } catch (e) {}
        // Subclips report their master's in/out through the DOM; their own
        // length is in the project metadata (VideoDuration / AudioDuration).
        var subLen = d.type === "clip" ? subclipLength(it) : null;
        if (subLen !== null && d.duration !== undefined && subLen < d.duration - 0.02) { d.duration = r3(subLen); d.subclip = true; }
        try { if (it.isOffline()) d.offline = true; } catch (e2) {}
        if (d.type === "sequence") { var sf = sequenceFps(it); if (sf) d.fps = sf; }
        else { try { var fi = it.getFootageInterpretation(); if (fi && fi.frameRate > 0) { d.fps = r3(fi.frameRate); } } catch (e3) {} }
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
  // QE sequence of the last activated sequence, valid for one host call (reset
  // by the dispatcher) so batch edits do not re-resolve it for every clip.
  var _qsCache = null;
  function activate(seq) {
    var p = requireProject();
    if (p.activeSequence && String(p.activeSequence.sequenceID) === String(seq.sequenceID)) return;
    _qsCache = null;
    p.openSequence(seq.sequenceID);
  }
  function qeSequenceFor(seq) {
    var id = String(seq.sequenceID);
    if (_qsCache && _qsCache.id === id) return _qsCache.qs;
    ensureQE();
    activate(seq);
    var qs = qe.project.getActiveSequence();
    if (!qs) fail("QE_NO_SEQUENCE", "QE could not resolve the sequence.");
    _qsCache = { id: id, qs: qs };
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
    try {
      var sp = c.getSpeed();
      if (sp && Math.abs(sp - 1) > 0.0001 && Math.abs(sp - 100) > 0.0001) {
        d.speed = sp;
        // DOM in/out are divided by the speed; report real media seconds.
        d["in"] = r3(tsec(c.inPoint) * sp);
        d.out = r3(tsec(c.outPoint) * sp);
      }
    } catch (e2) {}
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
  // Clips linked to a TrackItem (its audio for a video clip and vice versa), as
  // selector entries. getLinkedItems() includes the clip itself; it returns null
  // for unlinked clips.
  function linkedEntries(seq, clip) {
    var out = [], l = null, id = String(clip.nodeId);
    try { l = clip.getLinkedItems(); } catch (e) {}
    if (!l) return out;
    for (var i = 0; i < l.numItems; i++) {
      var c = l[i];
      if (!c || String(c.nodeId) === id) continue;
      var video = true, idx = -1;
      try { video = String(c.mediaType) === "Video"; idx = c.parentTrackIndex; } catch (e2) {}
      var coll = video ? seq.videoTracks : seq.audioTracks;
      if (!(idx >= 0 && idx < coll.numTracks)) { var f = findClip(seq, c.nodeId); if (f) out.push(f); continue; }
      out.push({ clip: c, track: trackLabel(video, idx), index: -1, trackObj: coll[idx], video: video, linkedTo: id });
    }
    return out;
  }
  // The selection plus every clip linked to it (deduplicated), unless include is false.
  function withLinked(seq, list, include) {
    if (include === false) return list;
    var out = [], seen = {};
    for (var i = 0; i < list.length; i++) { var id = String(list[i].clip.nodeId); if (!seen[id]) { seen[id] = 1; out.push(list[i]); } }
    for (var j = 0; j < list.length; j++) {
      var ls = linkedEntries(seq, list[j].clip);
      for (var k = 0; k < ls.length; k++) { var lid = String(ls[k].clip.nodeId); if (!seen[lid]) { seen[lid] = 1; out.push(ls[k]); } }
    }
    return out;
  }
  // Shared pre-edit check: refuse when any clip to edit sits on a locked track
  // (Premiere ignores DOM edits there and QE edits fail silently).
  function requireUnlocked(entries) {
    var seen = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], key = e.track;
      if (seen[key]) continue;
      seen[key] = 1;
      var locked = false;
      try { locked = !!(e.trackObj && e.trackObj.isLocked()); } catch (ex) {}
      if (locked) fail("TRACK_LOCKED", e.track + " is locked (clip '" + e.clip.name + "').", "Unlock it with manage_tracks action 'set' lock: false.");
    }
    return entries;
  }
  function requireClips(seq, sel) {
    var list = selectClips(seq, sel);
    if (!list.length) fail("NO_CLIPS_MATCHED", "No timeline clips matched the selector.", "Check ids with get_timeline, or relax the selector.");
    return list;
  }
  // Index of the first clip on a track whose start is >= ticks (clips are kept
  // sorted by start). Binary search: a track with hundreds of clips costs a
  // handful of DOM reads instead of one per clip.
  function lowerBoundClip(clips, ticks) {
    var lo = 0, hi = clips.numItems;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (parseFloat(clips[mid].start.ticks) < ticks) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function findPlacedClip(trackObj, ticks, nodeId, tolerance) {
    var clips = trackObj.clips, n = clips.numItems;
    if (!n) return null;
    var at = lowerBoundClip(clips, ticks - tolerance), best = null, bestD = 1e30;
    for (var i = Math.max(0, at - 1); i < n && i <= at + 3; i++) {
      var c = clips[i];
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
    // Fast path: Motion is always component 1 and Opacity component 0 of a video clip.
    var rn = typeof ref === "string" ? (ALIASES[normName(ref)] || ref) : null;
    if (rn === "AE.ADBE Motion" || rn === "AE.ADBE Opacity") {
      var fi = rn === "AE.ADBE Motion" ? 1 : 0;
      try { if (comps.numItems > fi && String(comps[fi].matchName) === rn) return comps[fi]; } catch (eF) {}
    }
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
    // Fast path for Motion: fixed property order, no name scan (names are localized).
    if (MOTION_INDEX[n] !== undefined && comp._isMotion !== false) {
      var mn0 = "";
      try { mn0 = String(comp.matchName); } catch (eM) {}
      if (mn0 === "AE.ADBE Motion" && MOTION_INDEX[n] < props.numItems) return props[MOTION_INDEX[n]];
    }
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
    // Color properties read back as a packed 64-bit number (0xAAAARRRRGGGGBBBB);
    // report them as "#RRGGBB" through getColorValue() instead.
    if (typeof v === "number" && (v === 0 || v > 4294967295) && typeof p.getColorValue === "function") {
      var cv = null;
      try { cv = p.getColorValue(); } catch (eC) {}
      if (cv instanceof Array && cv.length === 4) {
        var hex = "#";
        for (var h = 1; h < 4; h++) { var x = Math.max(0, Math.min(255, Math.round(cv[h]))); hex += (x < 16 ? "0" : "") + x.toString(16).toUpperCase(); }
        return hex;
      }
    }
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
  // Property setters take an "update UI" flag. Fast batches (sequence closed)
  // turn it off: nothing is on screen to refresh, and each refresh costs time.
  var UPDATE_UI = true;
  // fresh: the clip was just placed, so it has no keyframes yet (skips a DOM call).
  function applyValue(p, value, fresh) {
    var cv = coerceValue(p, value);
    if (cv.color) {
      var c = cv.color;
      if (typeof p.setColorValue !== "function") fail("BAD_VALUE", "Property " + p.displayName + " is not a color property");
      p.setColorValue(c[0], c[1], c[2], c[3], UPDATE_UI);
      return;
    }
    if (!fresh && p.isTimeVarying && p.isTimeVarying()) {
      fail("PROPERTY_ANIMATED", "Property '" + p.displayName + "' has keyframes; a static set would be ignored.", "Use add_keyframes, or remove_keyframes first.");
    }
    p.setValue(cv.value, UPDATE_UI);
  }
  function applyValueAtKey(p, time, value) {
    var cv = coerceValue(p, value);
    if (cv.color) fail("BAD_VALUE", "Keyframing color properties is not supported.");
    p.setValueAtKey(time, cv.value, UPDATE_UI);
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
    var want = parseFloat(entry.clip.start.ticks), n = qt.numItems;
    // QE items (clips and empty gaps) are sorted by start: binary search first.
    var lo = 0, hi = n;
    while (lo < hi) {
      var mid = (lo + hi) >> 1, ms = NaN;
      try { ms = parseFloat(qt.getItemAt(mid).start.ticks); } catch (eB) {}
      if (!(ms >= want - 2)) lo = mid + 1; else hi = mid;
    }
    for (var j = Math.max(0, lo - 1); j < n && j <= lo + 2; j++) {
      var q = null;
      try { q = qt.getItemAt(j); } catch (eQ) {}
      if (!q || String(q.type) !== "Clip") continue;
      try { if (Math.abs(parseFloat(q.start.ticks) - want) < 2) return q; } catch (eQ2) {}
    }
    for (var i = 0; i < n; i++) {
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
    res.projects = openProjects();
    return res;
  };
  function openProjects() {
    var out = [];
    try { for (var i = 0; i < app.projects.numProjects; i++) { var pr = app.projects[i]; out.push({ name: pr.name, path: pr.path, active: !!(app.project && pr.path === app.project.path) }); } } catch (e) {}
    return out;
  }
  function sameProject(pr, ref) {
    var r = lower(String(ref).replace(/\\/g, "/")), path = lower(String(pr.path).replace(/\\/g, "/"));
    return path === r || lower(pr.name) === r || lower(pr.name) === r + ".prproj";
  }
  // Make the project named/pathed by ref the active one, or fail with PROJECT_MISMATCH.
  H.select_project = function (a) {
    if (app.project && sameProject(app.project, a.project)) return { project: app.project.name, path: app.project.path, switched: false };
    var target = null;
    for (var i = 0; i < app.projects.numProjects; i++) if (sameProject(app.projects[i], a.project)) target = app.projects[i];
    if (target) {
      // Opening an already open project brings it to the front and makes it active.
      try { app.openDocument(target.path, true, true, true, true); } catch (e) {}
      if (app.project && sameProject(app.project, a.project)) return { project: app.project.name, path: app.project.path, switched: true };
    }
    var names = [];
    var list = openProjects();
    for (var k = 0; k < list.length; k++) names.push(list[k].name);
    fail("PROJECT_MISMATCH", target ? "Could not make '" + a.project + "' the active project." : "Project '" + a.project + "' is not open. Open: " + names.join(", "), "Open it with project_file action 'open', or omit project to use the active one.");
  };
  // Project guard: fail unless the active project is the expected one.
  H.check_project = function (a) {
    var want = lower(String(a.path).replace(/\\/g, "/")), cur = "";
    try { cur = lower(String(app.project.path).replace(/\\/g, "/")); } catch (e) {}
    if (!cur || cur !== want) fail("PROJECT_MISMATCH", "The active project is " + (cur ? app.project.path : "none") + ", not " + a.path + ".", "Pass project to switch to it, or open it with project_file.");
    return { project: app.project.name, path: app.project.path };
  };
  H.close_other_projects = function () {
    var keep = app.project ? app.project.path : null, closed = [];
    for (var i = app.projects.numProjects - 1; i >= 0; i--) {
      var pr = app.projects[i];
      if (keep && pr.path === keep) continue;
      var n = pr.name;
      try { if (pr.closeDocument(0, 0)) closed.push(n); } catch (e) {}
    }
    return { closed: closed, open: openProjects() };
  };

  H.get_state = function (a) {
    var p = requireProject();
    var seqs = allSequences(), list = [];
    for (var i = 0; i < seqs.length; i++) list.push({ id: String(seqs[i].sequenceID), name: seqs[i].name });
    var counts = { bins: 0, items: 0, offline: 0 };
    walk(p.rootItem, "", function (it) { if (it.type === 2) counts.bins++; else { counts.items++; try { if (it.isOffline()) counts.offline++; } catch (e) {} } });
    var st = { premiere: app.version, project: { name: p.name, path: p.path }, counts: counts };
    if (a.compact) st.sequenceCount = list.length; else st.sequences = list;
    if (p.activeSequence) st.active = summarizeSequence(p.activeSequence);
    var open = openProjects();
    if (open.length > 1) { st.openProjects = open; st.warning = open.length + " projects are open; tools act on the active one (" + p.name + "). Pass project to choose, or project_file close_others."; }
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
    var act = focusProject(f.fsName);
    return { opened: !!ok, project: app.project ? app.project.name : null, path: app.project ? app.project.path : null, active: act };
  };
  // With other projects open, a new/opened project is not always the one
  // app.project points at; reopening an open project brings it to the front.
  function focusProject(path) {
    var want = lower(new File(path).fsName);
    for (var t = 0; t < 3; t++) {
      if (app.project && lower(new File(app.project.path).fsName) === want) return true;
      try { app.openDocument(new File(path).fsName, true, true, true, true); } catch (e) {}
    }
    return !!(app.project && lower(new File(app.project.path).fsName) === want);
  }
  H.new_project = function (a) {
    var f = new File(a.path);
    if (f.exists) fail("FILE_EXISTS", "A file already exists at " + f.fsName + ".", "Pick a new path, or open it with action 'open'.");
    // newProject can throw "Unknown error exception" and still create the project
    // (seen with other projects open): judge by the result, not the call.
    var err = null;
    try { app.newProject(f.fsName); } catch (eN) { err = String(eN); }
    var act = focusProject(f.fsName);
    if (!act && !new File(f.fsName).exists) fail("PROJECT_CREATE_FAILED", "Premiere did not create " + f.fsName + (err ? " (" + err + ")" : "") + ".");
    try { app.project.save(); } catch (e) {}
    if (!act) act = focusProject(f.fsName);
    if (!act) fail("PROJECT_NOT_ACTIVE", "Created " + f.fsName + " but Premiere kept another project active.", "Close the other projects (project_file close_others) and retry.");
    return { created: true, path: f.fsName, name: decodeURI(f.name), active: lower(String(app.project.path)) === lower(f.fsName) };
  };
  H.close_project = function (a) {
    var p = requireProject(), path = String(p.path), name = p.name, err = null;
    try { p.closeDocument(a.save ? 1 : 0, 0); } catch (e) { err = String(e); }
    // closeDocument can throw after closing: verify with the list of open projects.
    var still = false;
    try { for (var i = 0; i < app.projects.numProjects; i++) if (String(app.projects[i].path) === path) still = true; } catch (e2) {}
    if (still) fail("CLOSE_FAILED", "Premiere did not close " + name + (err ? " (" + err + ")" : "") + ".");
    return { closed: true, project: name, saved: !!a.save };
  };

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
    if (d.subclip) {
      var b = subclipBounds(it);
      if (b) { d["in"] = b["in"]; d.out = b.out; d.duration = r3(b.out - b["in"]); }
      else { delete d["in"]; delete d.out; d.note = "Subclip bounds could not be read; duration comes from the project metadata."; }
    }
    try { var m = it.getMarkers(); if (m) d.markers = m.numMarkers; } catch (e3) {}
    if (a.metadata || a.raw_xml) {
      var pm = "", xmp = "";
      try { pm = String(it.getProjectMetadata()); } catch (e4) {}
      try { xmp = String(it.getXMPMetadata()); } catch (e5) {}
      if (a.metadata) d.metadata = parseItemMetadata(pm, xmp);
      if (a.raw_xml) { d.projectMetadataXml = pm; d.xmpXml = xmp; }
    }
    return d;
  };
  // Seconds of a Premiere timecode column ("00:00:02:00" at fps, or
  // "00:00:12:00000" with audio samples) or null.
  function tcColSeconds(tc, fpsGuess) {
    var m = /^(\d+)[:;](\d+)[:;](\d+)[:;](\d+)$/.exec(trim(tc || ""));
    if (!m) return null;
    var sub = m[4].length > 3 ? parseFloat(m[4]) / 48000 : parseFloat(m[4]) / (fpsGuess > 0 ? Math.round(fpsGuess) : 30);
    return parseFloat(m[1]) * 3600 + parseFloat(m[2]) * 60 + parseFloat(m[3]) + sub;
  }
  function subclipLength(it) {
    var pm = "";
    try { pm = String(it.getProjectMetadata()); } catch (e) { return null; }
    function col(n) { var r = new RegExp("Column\\.Intrinsic\\." + n + ">([^<]*)<").exec(pm); return r ? trim(r[1]) : ""; }
    var fr = 30;
    try { var fi = it.getFootageInterpretation(); if (fi && fi.frameRate > 0) fr = fi.frameRate; } catch (e2) {}
    var v = tcColSeconds(col("VideoDuration"), fr), au = tcColSeconds(col("AudioDuration"), fr);
    return v !== null ? v : au;
  }
  var _subclipBounds = {};
  // Real in/out of a subclip: place it on a throw-away sequence and read the clip.
  function subclipBounds(it) {
    var key = String(it.nodeId) + "|" + projectKey();
    if (_subclipBounds[key]) return _subclipBounds[key];
    var preset = findSequencePreset();
    if (!preset) return null;
    var before = {}, seqs0 = allSequences(), probe = null, res = null;
    for (var i = 0; i < seqs0.length; i++) before[String(seqs0[i].sequenceID)] = true;
    try {
      ensureQE();
      qe.project.newSequence("__mcp_probe", new File(preset).fsName);
      var seqs = allSequences();
      for (var j = 0; j < seqs.length; j++) if (!before[String(seqs[j].sequenceID)]) probe = seqs[j];
      if (!probe) return null;
      // Same frame rate as the media, so the in/out are not snapped to another grid.
      try { var fi = it.getFootageInterpretation(); if (fi && fi.frameRate > 0) applySeqSettings(probe, { fps: fi.frameRate }); } catch (eF) {}
      var st = itemStreams(it), tr = st.video ? probe.videoTracks[0] : probe.audioTracks[0];
      tr.overwriteClip(it, 0);
      if (tr.clips.numItems) { var c = tr.clips[0]; res = { "in": r3(tsec(c.inPoint)), out: r3(tsec(c.outPoint)) }; }
    } catch (e) { res = null; }
    finally { if (probe) { _qsCache = null; try { app.project.deleteSequence(probe); } catch (eD) {} } }
    if (res) _subclipBounds[key] = res;
    return res;
  }
  function xmlUnescape(s) { return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
  // Flatten Premiere's project metadata (premierePrivateProjectMetaData:Column.*)
  // and the useful XMP fields into plain values.
  function parseItemMetadata(pm, xmp) {
    var cols = {}, re = /<premierePrivateProjectMetaData:Column\.([A-Za-z]+)\.([A-Za-z0-9_]+)>([\s\S]*?)<\/premierePrivateProjectMetaData:Column\.\1\.\2>/g, m;
    while ((m = re.exec(pm)) !== null) cols[m[2]] = xmlUnescape(trim(m[3]));
    var out = {};
    var map = { name: "Name", mediaType: "MediaType", frameRate: "MediaTimebase", mediaStart: "MediaStart", mediaEnd: "MediaEnd", mediaDuration: "MediaDuration",
      videoIn: "VideoInPoint", videoOut: "VideoOutPoint", videoDuration: "VideoDuration", audioIn: "AudioInPoint", audioOut: "AudioOutPoint", audioDuration: "AudioDuration",
      videoInfo: "VideoInfo", audioInfo: "AudioInfo", videoUsage: "VideoUsage", audioUsage: "AudioUsage", filePath: "FilePath", label: "Label", tapeName: "TapeName",
      description: "Description", comment: "Comment", logNote: "LogNote", goodTake: "Good", status: "Status", offline: "Offline", proxy: "Proxy" };
    for (var k in map) if (map.hasOwnProperty(k) && cols.hasOwnProperty(map[k]) && cols[map[k]] !== "") out[k] = cols[map[k]];
    var extra = {};
    for (var c in cols) if (cols.hasOwnProperty(c) && cols[c] !== "") { var used = false; for (var k2 in map) if (map.hasOwnProperty(k2) && map[k2] === c) used = true; if (!used) extra[c] = cols[c]; }
    out.other = extra;
    function xmpField(tag) { var r = new RegExp("<" + tag + ">([^<]*)</" + tag + ">").exec(xmp) || new RegExp(tag + "=\"([^\"]*)\"").exec(xmp); return r ? xmlUnescape(r[1]) : null; }
    var x = { timecode: xmpField("xmpDM:timeValue"), timeFormat: xmpField("xmpDM:timeFormat"), createDate: xmpField("xmp:CreateDate"), modifyDate: xmpField("xmp:ModifyDate"), format: xmpField("dc:format"), frameRate: xmpField("xmpDM:videoFrameRate") };
    var xo = {};
    for (var xk in x) if (x.hasOwnProperty(xk) && x[xk] !== null) xo[xk] = x[xk];
    out.xmp = xo;
    return out;
  }

  H.import_files = function (a) {
    var p = requireProject();
    var target = a.bin ? binByPath(a.bin, true) : p.rootItem;
    if (!target) target = p.rootItem;
    // Snapshot the whole tree: Premiere can drop imports into the root or a
    // parent bin instead of the requested one.
    var before = {};
    walk(p.rootItem, "", function (it) { before[String(it.nodeId)] = true; });
    var paths = asArray(a.paths), missing = [], ok = [];
    for (var j = 0; j < paths.length; j++) { var f = new File(paths[j]); if (f.exists) ok.push(f.fsName); else missing.push(paths[j]); }
    if (!ok.length) fail("FILE_NOT_FOUND", "None of the files exist: " + missing.join(", "));
    p.importFiles(ok, true, target, !!a.as_image_sequence);
    var fresh = [];
    walk(p.rootItem, "", function (it) { if (!before[String(it.nodeId)] && it.type !== 2) fresh.push(it); });
    var created = [], targetId = String(target.nodeId);
    for (var k = 0; k < fresh.length; k++) {
      var c = fresh[k];
      if (target !== p.rootItem) {
        var parentPath = binPathOf(c), wantPath = binPathOf(target);
        var inTarget = false;
        for (var t = 0; t < target.children.numItems; t++) if (String(target.children[t].nodeId) === String(c.nodeId)) inTarget = true;
        if (!inTarget) { try { c.moveBin(target); } catch (eMv) {} }
      }
      created.push(describeItem(c, binPathOf(c), false));
    }
    return { imported: created, missing: missing, requested: paths.length };
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
    var d = describeItem(sub, a.bin || "", true);
    // The DOM reports the master's in/out for a subclip: return what was made.
    d["in"] = r3(a["in"] || 0);
    if (has(a, "out")) { d.out = r3(a.out); d.duration = r3(a.out - (a["in"] || 0)); }
    d.subclip = true;
    _subclipBounds[String(sub.nodeId) + "|" + projectKey()] = { "in": d["in"], out: d.out };
    return d;
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
      // QE needs a native path (backslashes); forward slashes made it fail silently.
      var pf = new File(preset);
      if (!pf.exists) fail("FILE_NOT_FOUND", "Sequence preset not found: " + preset);
      ensureQE();
      qe.project.newSequence(name, pf.fsName);
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
    // Premiere reports "no in/out point" as -400000 s.
    function pt(t) { var v = tsec(t); return isNaN(v) || v < -399999 ? null : r3(v); }
    try { out["in"] = pt(s.getInPointAsTime()); out.out = pt(s.getOutPointAsTime()); } catch (e2) {}
    try { out.workArea = { "in": pt(s.getWorkAreaInPointAsTime()), out: pt(s.getWorkAreaOutPointAsTime()) }; } catch (e3) {}
    try { out.workArea.enabled = !!s.isWorkAreaEnabled(); } catch (e4) {}
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
    var res = summarizeSequence(copy);
    if (a.activate) activate(copy); else activate(s);
    res.activeSequence = { id: String(app.project.activeSequence.sequenceID), name: app.project.activeSequence.name };
    return res;
  };
  H.rename_sequence = function (a) { var s = getSequence(a.sequence); s.name = a.name; return { id: String(s.sequenceID), name: s.name }; };
  H.delete_sequence = function (a) { var s = getSequence(a.sequence), n = s.name; app.project.deleteSequence(s); return { deleted: n }; };
  H.set_sequence_range = function (a) {
    var s = getSequence(a.sequence), out = {};
    if (has(a, "in")) s.setInPoint(a["in"]);
    if (has(a, "out")) s.setOutPoint(a.out);
    if (has(a, "playhead")) s.setPlayerPosition(String(snapTicks(s, secToTicks(a.playhead))));
    if (has(a, "work_in") || has(a, "work_out")) {
      // The work area is off by default on Premiere 26: switch it on first.
      try { if (s.setWorkAreaEnabled && !s.isWorkAreaEnabled()) s.setWorkAreaEnabled(true); } catch (eW) {}
      if (has(a, "work_in")) s.setWorkAreaInPoint(a.work_in);
      if (has(a, "work_out")) s.setWorkAreaOutPoint(a.work_out);
      var half = 0.5 / fps(s), wi = tsec(s.getWorkAreaInPointAsTime()), wo = tsec(s.getWorkAreaOutPointAsTime());
      var bad = (has(a, "work_in") && Math.abs(wi - a.work_in) > half) || (has(a, "work_out") && Math.abs(wo - a.work_out) > half);
      if (bad) fail("WORK_AREA_UNSUPPORTED", "Premiere did not accept the work area (it still reads " + r3(wi) + "-" + r3(wo) + "s). Premiere " + app.version + " ignores work area changes from scripts.", "Use in/out points instead (manage_sequence range with in/out, then export_sequence range 'in_out').");
    }
    return H.get_sequence_settings(a);
  };
  H.get_playhead = function (a) { var s = getSequence(a.sequence); return { seconds: r3(tsec(s.getPlayerPosition())), timecode: timecodeFor(s, s.getPlayerPosition().ticks) }; };
  H.set_playhead = function (a) { var s = getSequence(a.sequence); s.setPlayerPosition(String(snapTicks(s, secToTicks(a.seconds)))); return H.get_playhead(a); };

  // Compact timeline: one row per clip [id, name, start, end, in, out] (DOM in/out,
  // i.e. media seconds / speed), no media paths, effects or track states.
  // Timeline read cache: valid while nothing changed (our own edits bump
  // MUTATIONS; edits by hand move Premiere's undo index; sequence end too).
  var MUTATIONS = 0, _tlCache = {};
  var FIELD_ORDER = ["id", "name", "start", "end", "in", "out"];
  function compactTimeline(s, a) {
    var fields = a.fields ? asArray(a.fields) : FIELD_ORDER;
    var key = MUTATIONS + "|" + undoIndex() + "|" + s.end + "|" + fields.join(",");
    var sid = String(s.sequenceID), hit = _tlCache[sid];
    if (hit && hit.key === key && !has(a, "start") && !has(a, "end")) {
      var outC = { cached: true, fields: hit.res.fields, tracks: [] };
      for (var kk in hit.res) if (hit.res.hasOwnProperty(kk) && kk !== "tracks") outC[kk] = hit.res[kk];
      outC.cached = true;
      var w = null;
      if (a.tracks) { w = {}; var tl0 = asArray(a.tracks); for (var i0 = 0; i0 < tl0.length; i0++) w[String(tl0[i0]).toUpperCase()] = true; }
      for (var t0 = 0; t0 < hit.res.tracks.length; t0++) if (!w || w[hit.res.tracks[t0].track]) outC.tracks.push(hit.res.tracks[t0]);
      return outC;
    }
    var full = compactTimelineRead(s, { start: a.start, end: a.end, tracks: has(a, "start") || has(a, "end") ? a.tracks : null }, fields);
    if (!has(a, "start") && !has(a, "end")) _tlCache[sid] = { key: key, res: full };
    if (a.tracks && !has(a, "start") && !has(a, "end")) {
      var w2 = {}, tl2 = asArray(a.tracks), sub = [];
      for (var i2 = 0; i2 < tl2.length; i2++) w2[String(tl2[i2]).toUpperCase()] = true;
      for (var t2 = 0; t2 < full.tracks.length; t2++) if (w2[full.tracks[t2].track]) sub.push(full.tracks[t2]);
      var copy = {};
      for (var k2 in full) if (full.hasOwnProperty(k2)) copy[k2] = full[k2];
      copy.tracks = sub;
      return copy;
    }
    return full;
  }
  function compactTimelineRead(s, a, fields) {
    var res = summarizeSequence(s), wanted = null, tracks = [];
    var want = {};
    for (var f0 = 0; f0 < fields.length; f0++) want[fields[f0]] = true;
    if (a.tracks) { wanted = {}; var tl = asArray(a.tracks); for (var i = 0; i < tl.length; i++) wanted[String(tl[i]).toUpperCase()] = true; }
    var groups = [[s.videoTracks, true], [s.audioTracks, false]];
    for (var g = 0; g < groups.length; g++) {
      var coll = groups[g][0];
      for (var t = 0; t < coll.numTracks; t++) {
        var label = trackLabel(groups[g][1], t);
        if (wanted && !wanted[label]) continue;
        var clips = coll[t].clips, n = clips.numItems, rows = [];
        if (!n) continue;
        var from = has(a, "start") ? lowerBoundClip(clips, secToTicks(a.start) - TPS * 3600) : 0;
        for (var c = from; c < n; c++) {
          var cl = clips[c], cs = ticksToSec(cl.start.ticks), ce = ticksToSec(cl.end.ticks);
          if (has(a, "end") && cs >= a.end) break;
          if (has(a, "start") && ce <= a.start) continue;
          var row = [];
          for (var fi = 0; fi < fields.length; fi++) {
            var fn = fields[fi];
            if (fn === "id") row.push(String(cl.nodeId));
            else if (fn === "name") row.push(cl.name);
            else if (fn === "start") row.push(r3(cs));
            else if (fn === "end") row.push(r3(ce));
            else if (fn === "in") row.push(r3(ticksToSec(cl.inPoint.ticks)));
            else if (fn === "out") row.push(r3(ticksToSec(cl.outPoint.ticks)));
          }
          rows.push(row);
        }
        if (rows.length) tracks.push({ track: label, clips: rows });
      }
    }
    res.fields = fields;
    res.tracks = tracks;
    return res;
  }
  H.get_timeline = function (a) {
    var s = getSequence(a.sequence);
    if (a.compact) return compactTimeline(s, a);
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
    var audioType = a.audio_type === "mono" ? 0 : (a.audio_type === "5.1" ? 2 : (a.audio_type === "adaptive" ? 3 : 1));
    if (a.video) qs.addTracks(a.video, v0, 0, audioType, a0, 0, 0);
    if (a.audio) qs.addTracks(0, s.videoTracks.numTracks, a.audio, audioType, a0, 0, 0);
    return { videoTracks: s.videoTracks.numTracks, audioTracks: s.audioTracks.numTracks, addedVideo: s.videoTracks.numTracks - v0, addedAudio: s.audioTracks.numTracks - a0 };
  };
  H.delete_track = function (a) {
    var s = getSequence(a.sequence), t = parseTrackRef(a.track);
    var coll = t.video ? s.videoTracks : s.audioTracks;
    if (t.index >= coll.numTracks) fail("TRACK_NOT_FOUND", a.track + " does not exist");
    var target = coll[t.index];
    if (target.clips.numItems > 0 && !a.force) fail("TRACK_NOT_EMPTY", a.track + " has clips.", "Pass force: true to delete it anyway.");
    var before = coll.numTracks, targetId = String(target.id), targetName = target.name;
    try { if (target.isLocked()) target.setLocked(0); } catch (eL) {}
    var qs = qeSequenceFor(s);
    if (t.video) qs.removeVideoTrack(t.index); else qs.removeAudioTrack(t.index);
    // Verify by identity, not just by count: the track itself must be gone.
    var coll2 = t.video ? s.videoTracks : s.audioTracks, after = coll2.numTracks, still = false;
    for (var i = 0; i < after; i++) if (String(coll2[i].id) === targetId) still = true;
    if (after !== before - 1 || still) fail("TRACK_DELETE_FAILED", "Premiere did not remove " + a.track + " ('" + targetName + "').");
    return { deleted: a.track, name: targetName, remaining: after };
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
  var SUBCLIP_BIN = "_MCP Plus/Video-only", AUDIO_SUBCLIP_BIN = "_MCP Plus/Audio-only";
  function isHelperBin(path) { return path === SUBCLIP_BIN || path === AUDIO_SUBCLIP_BIN; }
  function itemHasAudioAndVideo(it) {
    // Heuristic: stills and audio files never need splitting.
    var mp = lower(itemMediaPath(it));
    if (/\.(png|jpe?g|tiff?|psd|bmp|gif|webp|ai|svg|exr|tga)$/.test(mp)) return false;
    if (/\.(wav|mp3|aif+|m4a|flac|ogg|aac)$/.test(mp)) return false;
    return true;
  }
  // Whether a project item carries audio / video, from its project metadata.
  function itemStreams(it) {
    var pm = "";
    try { pm = String(it.getProjectMetadata()); } catch (e) {}
    function col(n) { var m = new RegExp("Column\\.Intrinsic\\." + n + ">([^<]*)<").exec(pm); return m ? trim(m[1]) : ""; }
    var ai = col("AudioInfo"), vi = col("VideoInfo"), ad = col("AudioDuration"), vd = col("VideoDuration");
    if (!pm) return { audio: true, video: true };
    return { audio: !!(ai || ad), video: !!(vi || vd) };
  }
  var _helperCache = { video: {}, audio: {} };
  // A helper subclip is only reusable when it spans the whole master media.
  function coversMaster(sub, master) {
    try {
      sub.clearInPoint(); sub.clearOutPoint(); master.clearInPoint(); master.clearOutPoint();
      return tsec(sub.getOutPoint()) - tsec(sub.getInPoint()) >= tsec(master.getOutPoint()) - tsec(master.getInPoint()) - 0.05;
    } catch (e) { return true; }
  }
  // Video-only or audio-only subclip of a media file that has both: placing the
  // full item on one kind of track makes Premiere drop the other half onto the
  // matching track of the other kind (a "ghost" clip that can overwrite edits).
  function helperVersion(it, kind) {
    var key = String(it.nodeId), cache = _helperCache[kind], binPath = kind === "audio" ? AUDIO_SUBCLIP_BIN : SUBCLIP_BIN;
    // The subclip carries the source's own name, so timeline clips made from it
    // need no per-clip rename. Older versions named video ones "<name> [V]".
    var want = it.name, legacy = it.name + (kind === "audio" ? " [A]" : " [V]");
    // Node ids restart in every project, so a cached id is only trusted when it
    // still points at a helper subclip of the same media file.
    if (cache[key]) {
      var cached = findItemByNodeId(cache[key]);
      if (cached && cached.name === want && String(cached.nodeId) !== key && lower(itemMediaPath(cached)) === lower(itemMediaPath(it))) return cached;
      delete cache[key];
    }
    var bin = binByPath(binPath, true);
    for (var i = 0; i < bin.children.numItems; i++) {
      var c = bin.children[i];
      if ((c.name === want || c.name === legacy) && String(c.nodeId) !== key && lower(itemMediaPath(c)) === lower(itemMediaPath(it)) && coversMaster(c, it)) {
        if (c.name !== want) try { c.name = want; } catch (eR) {}
        cache[key] = String(c.nodeId);
        return c;
      }
    }
    // Measure the full media: any in/out left on the master would make a short subclip.
    var dur = 0;
    try { it.clearInPoint(); it.clearOutPoint(); } catch (e2) {}
    try { dur = tsec(it.getOutPoint()); } catch (e) {}
    var sub = makeSubclip(it, want, 0, dur > 0 ? dur : null, kind === "video", kind === "audio", binPath);
    cache[key] = String(sub.nodeId);
    return sub;
  }
  function videoOnlyVersion(it) { return helperVersion(it, "video"); }

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  // Full media length of a project item in seconds (null for stills / unknown).
  function mediaLength(it, cache) {
    var key = String(it.nodeId);
    if (cache && cache.len.hasOwnProperty(key)) return cache.len[key];
    var len = null;
    if (!isStillItem(it)) {
      try {
        it.clearInPoint(); it.clearOutPoint();
        if (cache) cache.forgetRange(it);
        var o = tsec(it.getOutPoint()), i0 = tsec(it.getInPoint());
        if (o > i0) len = o - i0;
      } catch (e) {}
    }
    if (cache) cache.len[key] = len;
    return len;
  }
  // Everything that can be checked without touching the timeline. A failure
  // here leaves the sequence unchanged.
  function validatePlacement(seq, spec, opts, cache) {
    var media = spec.media || (spec.video_only ? "video" : (spec.audio_only ? "audio" : "both"));
    if (media !== "both" && media !== "video" && media !== "audio") fail("BAD_ARGS", "media must be both, video or audio");
    var trackRef = spec.track || (media === "audio" ? "A1" : "V1");
    var tref = parseTrackRef(trackRef);
    if (tref.index < 0) fail("BAD_TRACK", "Track index must be >= 1.");
    if (media === "audio" && tref.video) fail("BAD_ARGS", "media 'audio' needs an audio track (A1...)");
    if ((media === "video" || media === "both") && !tref.video) fail("BAD_ARGS", "media '" + media + "' needs a video track (V1...); use media 'audio' for audio tracks.");
    if (spec.audio_track) { var at = parseTrackRef(spec.audio_track); if (at.video) fail("BAD_TRACK", "audio_track must be an audio track (A1...)"); }
    if (opts.auto_create_tracks === false) {
      var coll = tref.video ? seq.videoTracks : seq.audioTracks;
      if (tref.index >= coll.numTracks) fail("TRACK_NOT_FOUND", trackLabel(tref.video, tref.index) + " does not exist (sequence has " + coll.numTracks + ").", "Pass auto_create_tracks: true or call add_tracks.");
    }
    var start = has(spec, "start") ? spec.start : 0;
    if (!isNum(start) || start < 0) fail("BAD_ARGS", "start must be >= 0 (got " + spec.start + ").");
    if (has(spec, "in") && (!isNum(spec["in"]) || spec["in"] < 0)) fail("BAD_ARGS", "in must be >= 0 (got " + spec["in"] + ").");
    if (has(spec, "duration") && (!isNum(spec.duration) || spec.duration <= 0)) fail("BAD_ARGS", "duration must be > 0.");
    if (has(spec, "end") && (!isNum(spec.end) || spec.end <= start)) fail("BAD_ARGS", "end must be after start.");
    var inS = has(spec, "in") ? spec["in"] : 0;
    var outS = has(spec, "out") ? spec.out : (has(spec, "duration") && (has(spec, "in") || has(spec, "out")) ? inS + spec.duration : null);
    if (outS !== null && (!isNum(outS) || outS <= inS)) fail("BAD_ARGS", "out (" + outS + ") must be greater than in (" + inS + ").");
    var it = cache.item(spec.item);
    if (media === "audio" || media === "video") {
      var st = cache.streams(it);
      if (media === "audio" && !st.audio) fail("NO_AUDIO", "'" + it.name + "' has no audio to place on " + trackRef + ".");
      if (media === "video" && !st.video) fail("NO_VIDEO", "'" + it.name + "' has no video to place on " + trackRef + ".");
    }
    // Locked tracks: refuse before editing (Premiere silently drops the edit).
    var lockRefs = [trackRef];
    if (media === "both") lockRefs.push(spec.audio_track || ("A" + (tref.index + 1)));
    for (var lr = 0; lr < lockRefs.length; lr++) {
      var lt = parseTrackRef(lockRefs[lr]), lcoll = lt.video ? seq.videoTracks : seq.audioTracks;
      if (lt.index < lcoll.numTracks) { var locked = false; try { locked = !!lcoll[lt.index].isLocked(); } catch (eL) {} if (locked) fail("TRACK_LOCKED", trackLabel(lt.video, lt.index) + " is locked.", "Unlock it with manage_tracks action 'set' lock: false."); }
    }
    if (has(spec, "in") || outS !== null) {
      var len = mediaLength(it, cache), slack = 0.5 / fps(seq);
      if (len !== null) {
        if (inS >= len - slack) fail("BAD_ARGS", "in (" + inS + "s) is past the end of '" + it.name + "' (" + r3(len) + "s).");
        if (outS !== null && outS > len + slack) fail("BAD_ARGS", "out (" + outS + "s) is past the end of '" + it.name + "' (" + r3(len) + "s).");
      }
    }
    if (spec.transform && !tref.video) fail("BAD_ARGS", "transform needs a video track");
    if (spec.effects) {
      var fx = asArray(spec.effects), kind = tref.video ? "video" : "audio";
      for (var e = 0; e < fx.length; e++) cache.effect(kind, typeof fx[e] === "string" ? fx[e] : fx[e].name);
    }
    if (spec.keyframes) for (var k = 0; k < spec.keyframes.length; k++) if (!spec.keyframes[k] || !spec.keyframes[k].property) fail("BAD_ARGS", "keyframes[" + k + "].property is required");
    return { item: it, media: media, trackRef: trackRef, tref: tref, inS: inS, outS: outS };
  }
  function removeWithLinked(clip) {
    var l = null;
    try { l = clip.getLinkedItems(); } catch (e) {}
    var list = [];
    if (l) for (var i = 0; i < l.numItems; i++) list.push(l[i]);
    var seen = String(clip.nodeId), removedSelf = false;
    for (var j = 0; j < list.length; j++) { try { if (String(list[j].nodeId) === seen) removedSelf = true; list[j].remove(false, false); } catch (e2) {} }
    if (!removedSelf) try { clip.remove(false, false); } catch (e3) {}
  }
  // Per-call caches for batch placement. Setting a project item's in/out gets
  // slower with every timeline clip that uses the item (100+ ms once a few dozen
  // clips share it), and the audio half is the expensive part. So the range is
  // set only for the media actually placed, skipped when it repeats, and
  // cleared once at the end of the batch instead of after every clip.
  function placeCache() {
    var items = {}, effects = {}, paths = {}, av = {}, vonly = {}, aonly = {}, streams = {}, ranges = {}, touched = {};
    var c = {
      len: {},
      item: function (ref) { var k = String(ref); if (!items[k]) items[k] = resolveItem(ref); return items[k]; },
      effect: function (kind, name) { var k = kind + "|" + name; if (!effects.hasOwnProperty(k)) effects[k] = resolveCatalogName(kind, name); return effects[k]; },
      mediaPath: function (it) { var k = String(it.nodeId); if (!paths.hasOwnProperty(k)) paths[k] = itemMediaPath(it); return paths[k]; },
      hasAV: function (it) { var k = String(it.nodeId); if (!av.hasOwnProperty(k)) av[k] = itemHasAudioAndVideo(it); return av[k]; },
      videoOnly: function (it) { var k = String(it.nodeId); if (!vonly[k]) { vonly[k] = helperVersion(it, "video"); ranges[k] = null; ranges[String(vonly[k].nodeId)] = null; } return vonly[k]; },
      audioOnly: function (it) { var k = String(it.nodeId); if (!aonly[k]) { aonly[k] = helperVersion(it, "audio"); ranges[k] = null; ranges[String(aonly[k].nodeId)] = null; } return aonly[k]; },
      streams: function (it) { var k = String(it.nodeId); if (!streams[k]) streams[k] = itemStreams(it); return streams[k]; },
      // Make the item's in/out equal [inS, outS] (outS null = to the end) for mediaType mt.
      setRange: function (it, inS, outS, mt) {
        var k = String(it.nodeId), want = inS + "|" + outS + "|" + mt;
        if (ranges[k] === want) return;
        if (ranges[k] && ranges[k].split("|")[2] !== String(mt)) { it.clearInPoint(); it.clearOutPoint(); }
        it.setInPoint(String(secToTicks(inS)), mt);
        if (outS !== null) it.setOutPoint(String(secToTicks(outS)), mt);
        else { try { it.clearOutPoint(); } catch (e) {} }
        ranges[k] = want; touched[k] = it;
      },
      clearRange: function (it) { var k = String(it.nodeId); if (ranges[k]) { it.clearInPoint(); it.clearOutPoint(); ranges[k] = null; } },
      forgetRange: function (it) { ranges[String(it.nodeId)] = null; },
      finish: function () { for (var k in touched) if (touched.hasOwnProperty(k)) { try { touched[k].clearInPoint(); touched[k].clearOutPoint(); } catch (e) {} } touched = {}; ranges = {}; }
    };
    return c;
  }

  function placeOne(seq, spec, opts, cache) {
    var v = validatePlacement(seq, spec, opts, cache);
    var it = v.item, media = v.media, trackRef = v.trackRef, tref = v.tref;
    var placeItem = it;
    if (media === "video" && cache.hasAV(it)) placeItem = cache.videoOnly(it);
    if (media === "audio" && cache.hasAV(it)) placeItem = cache.audioOnly(it);
    var vt = null, at = null;
    if (tref.video) vt = getTrack(seq, trackRef, opts.auto_create_tracks !== false);
    else at = getTrack(seq, trackRef, opts.auto_create_tracks !== false);
    if (media === "both" && spec.audio_track) at = getTrack(seq, spec.audio_track, opts.auto_create_tracks !== false);
    var startTicks = snapTicks(seq, secToTicks(spec.start || 0));
    // Source range: set on the project item (only the media types placed).
    var hadRange = has(spec, "in") || v.outS !== null;
    var mt = media === "video" ? 1 : (media === "audio" ? 2 : 4);
    try {
      // A subclip is limited by its master's in/out: clear the master's range
      // (left set by an earlier "both" clip in this batch) before using one.
      if (placeItem !== it) cache.clearRange(it);
      if (hadRange) cache.setRange(placeItem, v.inS, v.outS, mt);
      else cache.clearRange(placeItem);
    } catch (e) {}
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
    if (err) fail("PLACE_FAILED", "Premiere rejected the edit for '" + it.name + "': " + err);
    var ft = frameTicks(seq), tol = ft / 2 + 2;
    var host = vt || at;
    placed = findPlacedClip(host.track, startTicks, placeItem.nodeId, tol);
    if (!placed) fail("PLACE_UNVERIFIED", "Edit ran but no clip was found at " + r3(ticksToSec(startTicks)) + "s on " + host.label + ".");
    // From here on the clip exists: any failure removes it again (with its
    // linked audio) so an error never leaves a clip on the timeline.
    try {
      var wantEnd = has(spec, "end") ? spec.end : (has(spec, "duration") && !hadRange ? (spec.start || 0) + spec.duration : null);
      if (wantEnd === null && v.outS !== null) {
        // Audio-only items can come out one frame short (out point truncated to
        // the frame before); round the length to the nearest frame instead.
        var wantTicks = snapTicks(seq, secToTicks(v.outS - v.inS));
        var gotTicks = parseFloat(placed.end.ticks) - startTicks;
        if (Math.abs(gotTicks - wantTicks) > tol) wantEnd = ticksToSec(startTicks + wantTicks);
      }
      if (wantEnd !== null) {
        var linkedEnd = [];
        try { var lk = placed.getLinkedItems(); if (lk) for (var q = 0; q < lk.numItems; q++) linkedEnd.push(lk[q]); } catch (eLk) {}
        if (!linkedEnd.length) linkedEnd.push(placed);
        var endT = seqTime(seq, wantEnd);
        for (var le = 0; le < linkedEnd.length; le++) {
          var lc = linkedEnd[le], lDur = ticksToSec(parseFloat(endT.ticks) - parseFloat(lc.start.ticks));
          try { lc.end = endT; } catch (e4) {}
          // start/end and in/out are independent setters on 26.x: keep them in sync.
          try { lc.outPoint = timeFromSec(tsec(lc.inPoint) + lDur); } catch (e4b) {}
        }
        placed = findPlacedClip(host.track, startTicks, placeItem.nodeId, tol) || placed;
      }
      if (spec.name) { try { placed.name = spec.name; } catch (e5) {} }
      if (has(spec, "enabled")) try { placed.disabled = !spec.enabled; } catch (e6) {}
      var entry = { clip: placed, track: host.label, index: 0, trackObj: host.track, video: host.video, _fresh: true };
      // Read the timing once: it feeds both the keyframe base and the result.
      var tS = parseFloat(placed.start.ticks), tE = parseFloat(placed.end.ticks), tI = parseFloat(placed.inPoint.ticks), tO = parseFloat(placed.outPoint.ticks);
      entry._base = { clip: placed, base: { inTicks: tI, speed: 1, dur: (tE - tS) / TPS, start: tS / TPS } };
      entry._times = [tS, tE, tI, tO];
      // Effects go through QE, which needs the sequence open; in a fast batch
      // (sequence closed) they and everything that may target them run later.
      if (spec.effects && opts._deferred) opts._deferred.push({ entry: entry, spec: spec, id: String(placed.nodeId), start: startTicks });
      else if (opts._post && (spec.transform || spec.keyframes || spec.properties || spec.volume_db !== undefined)) opts._post.push({ entry: entry, spec: spec, id: String(placed.nodeId), start: startTicks });
      else { if (spec.transform) applyTransform(seq, entry, spec.transform); finishPlacement(seq, entry, spec, cache); }
      placed = entry.clip;
    } catch (ePost) {
      removeWithLinked(placed);
      throw ePost;
    }
    // Lean read-back: a fresh clip has speed 1 and is enabled unless asked otherwise.
    var tm = entry && entry._times && entry.clip === placed ? entry._times : [parseFloat(placed.start.ticks), parseFloat(placed.end.ticks), parseFloat(placed.inPoint.ticks), parseFloat(placed.outPoint.ticks)];
    var info = { id: String(placed.nodeId), track: host.label, name: spec.name || it.name, start: r3(tm[0] / TPS), end: r3(tm[1] / TPS), "in": r3(tm[2] / TPS), out: r3(tm[3] / TPS) };
    if (has(spec, "enabled") && !spec.enabled) info.disabled = true;
    info.item = String(it.nodeId);
    var mpath = cache.mediaPath(it);
    if (mpath) info.media = mpath;
    delete info.index;
    if (media === "video" && placeItem !== it) info.videoOnly = true;
    if (media === "audio" && placeItem !== it) info.audioOnly = true;
    return info;
  }

  function finishPlacement(seq, entry, spec, cache) {
    if (spec.transform && entry._needTransform) applyTransform(seq, entry, spec.transform);
    if (spec.effects) applyEffectsTo(seq, [entry], asArray(spec.effects), cache);
    if (spec.properties) for (var p = 0; p < spec.properties.length; p++) setPropsOn(seq, entry, spec.properties[p]);
    if (spec.keyframes) for (var k = 0; k < spec.keyframes.length; k++) addKeysOn(entry, spec.keyframes[k]);
    if (spec.volume_db !== undefined) setVolumeOn(entry, spec.volume_db, seq);
  }
  // Create every track a batch needs up front (QE track creation reopens the
  // sequence, which a fast batch keeps closed).
  function ensureBatchTracks(seq, clips, opts) {
    if (opts.auto_create_tracks === false) return;
    var maxV = -1, maxA = -1;
    for (var i = 0; i < clips.length; i++) {
      var sp = clips[i] || {}, media = sp.media || (sp.video_only ? "video" : (sp.audio_only ? "audio" : "both"));
      var t = null;
      try { t = parseTrackRef(sp.track || (media === "audio" ? "A1" : "V1")); } catch (e) { continue; }
      if (t.video) { if (t.index > maxV) maxV = t.index; if (media === "both" && !sp.audio_track && t.index > maxA) maxA = t.index; }
      else if (t.index > maxA) maxA = t.index;
      if (sp.audio_track) { try { var at = parseTrackRef(sp.audio_track); if (!at.video && at.index > maxA) maxA = at.index; } catch (e2) {} }
    }
    var addV = maxV - seq.videoTracks.numTracks + 1, addA = maxA - seq.audioTracks.numTracks + 1;
    if (addV > 0 || addA > 0) addTracksQE(seq, addV > 0 ? addV : 0, addA > 0 ? addA : 0);
  }
  H.place_clips = function (a) {
    var s = getSequence(a.sequence), cache = placeCache();
    var clips = asArray(a.clips), placed = [], errors = [], byIndex = [];
    // Editing the sequence that is open in the Timeline makes Premiere redraw it
    // after every clip (~200 ms/clip). For larger batches close its tab while
    // placing and reopen it afterwards (~40-80 ms/clip).
    var fast = a.fast !== false && clips.length >= 10 && app.project.activeSequence && String(app.project.activeSequence.sequenceID) === String(s.sequenceID);
    // Keep the project object: with several projects open, closing every tab of
    // this one can make Premiere switch app.project to another project.
    var opts = a, closed = false, sid = s.sequenceID, reopen = [], proj = requireProject();
    if (fast) {
      ensureBatchTracks(s, clips, a);
      opts = {};
      for (var k in a) if (a.hasOwnProperty(k)) opts[k] = a[k];
      opts._deferred = [];
      opts._post = a.group_post === false ? null : [];
      _qsCache = null;
      // Other open sequences (timeline tabs) are refreshed too when an item they
      // use changes: 3 open tabs made a batch ~2.5x slower. Close them as well
      // when the batch is big enough to pay for reopening (~0.6 s per tab).
      try {
        ensureQE();
        var openIds = [];
        for (var qi = 0; qi < qe.project.numSequences; qi++) {
          var qsq = qe.project.getSequenceAt(qi);
          if (qsq && qsq.isOpen() && String(qsq.guid) !== String(sid)) openIds.push(String(qsq.guid));
        }
        if (openIds.length && clips.length >= 4 * openIds.length) {
          var seqsAll = allSequences();
          for (var oi = 0; oi < openIds.length; oi++) for (var sj = 0; sj < seqsAll.length; sj++) if (String(seqsAll[sj].sequenceID) === openIds[oi]) { try { if (seqsAll[sj].close()) reopen.push(openIds[oi]); } catch (eO2) {} }
        }
      } catch (eQ) {}
      // Closing every tab of this project can hand app.project to another open
      // project; lookups use the project pinned at the start of the call, and
      // the dispatcher gives the focus back at the end.
      try { closed = !!s.close(); } catch (eC) { closed = false; }
      if (closed && a.update_ui !== true) UPDATE_UI = false;
      if (!closed) opts._deferred = null;
    }
    try {
      for (var i = 0; i < clips.length; i++) {
        try {
          var info = placeOne(s, clips[i], opts, cache);
          placed.push(info);
          byIndex.push(i);
          var lists = [opts._deferred, opts._post];
          for (var li = 0; li < lists.length; li++) { var L = lists[li]; if (L && L.length && !L[L.length - 1].info) { L[L.length - 1].info = info; L[L.length - 1].index = i; } }
        } catch (e) {
          errors.push({ index: i, item: clips[i].item, error: e && e.message ? e.message : String(e), code: e && e.code });
          if (a.stop_on_error) break;
        }
      }
      // Grouped second pass (sequence still closed): transform, keyframes,
      // properties and volume of the clips placed above.
      if (opts._post) for (var pp = 0; pp < opts._post.length; pp++) {
        var pj = opts._post[pp];
        try {
          var pe = pj.entry;
          pe._needTransform = true;
          finishPlacement(s, pe, pj.spec, cache);
        } catch (eP) {
          removeWithLinked(pj.entry.clip);
          for (var px = 0; px < placed.length; px++) if (placed[px] === pj.info) { placed.splice(px, 1); byIndex.splice(px, 1); break; }
          errors.push({ index: pj.index, item: pj.spec.item, error: eP && eP.message ? eP.message : String(eP), code: eP && eP.code });
        }
      }
    } finally {
      UPDATE_UI = true;
      cache.finish(); // restore the items' in/out (cleared) once per batch
      _qsCache = null;
      for (var ro = 0; ro < reopen.length; ro++) try { proj.openSequence(reopen[ro]); } catch (eR) {}
      if (closed || reopen.length) { try { proj.openSequence(sid); } catch (eO) {} }
    }
    // Third pass: effects (QE) on the reopened sequence.
    if (opts._deferred && opts._deferred.length) {
      for (var d = 0; d < opts._deferred.length; d++) {
        var job = opts._deferred[d], entry = job.entry;
        entry._needTransform = true;
        try {
          // TrackItem objects from before the reopen are stale: look the clip up again.
          entry.trackObj = getTrack(s, entry.track, false).track;
          var fresh = null, cl = entry.trackObj.clips, at0 = lowerBoundClip(cl, job.start - 2);
          for (var q = Math.max(0, at0 - 1); q < cl.numItems && q <= at0 + 2; q++) if (String(cl[q].nodeId) === job.id) fresh = cl[q];
          if (!fresh) { var fc = findClip(s, job.id); if (fc) fresh = fc.clip; }
          if (!fresh) fail("PLACE_UNVERIFIED", "The clip placed for item " + job.spec.item + " disappeared before its effects were applied.");
          entry.clip = fresh;
          finishPlacement(s, entry, job.spec, cache);
        } catch (eF) {
          removeWithLinked(entry.clip);
          for (var p = 0; p < placed.length; p++) if (placed[p] === job.info) { placed.splice(p, 1); byIndex.splice(p, 1); break; }
          errors.push({ index: job.index, item: job.spec.item, error: eF && eF.message ? eF.message : String(eF), code: eF && eF.code });
        }
      }
    }
    var res = { placed: placed, errors: errors, sequence: s.name };
    if (closed) res.fastBatch = true;
    return res;
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
    var info = clipInfo(clip, entry.track, -1, {});
    delete info.index;
    info.imported = true;
    var nativeInfo = nativeGraphicInfo(clip);
    if (nativeInfo) {
      // Templates made in Premiere's Essential Graphics panel (e.g. the stock
      // "Basic Lower Third") have no MGT component; their Source Text is an
      // opaque binary blob that ExtendScript cannot edit.
      info.nativeGraphic = nativeInfo;
      info.warning = "Imported. This is a native Premiere graphic, so its text cannot be edited by script. Use an After Effects .mogrt for editable params, or create_title_image for scripted text.";
      if (a.params) info.paramsNotApplied = true;
      return info;
    }
    if (a.params) info.set = setMogrtParams(clip, a.params);
    info.params = listMogrtParams(clip);
    return info;
  };
  function nativeGraphicInfo(clip) {
    var mgt = null;
    try { mgt = clip.getMGTComponent(); } catch (e) {}
    if (mgt) return null;
    var texts = 0, layers = [];
    for (var i = 0; i < clip.components.numItems; i++) {
      var c = clip.components[i], m = "";
      try { m = String(c.matchName); } catch (e2) {}
      if (m === "AE.ADBE Text") { texts++; var pos = null; try { pos = readValue(c.properties[2]); } catch (e3) {} layers.push({ component: i, position: pos }); }
    }
    return { textLayers: texts, layers: layers, editableText: false };
  }
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
    for (var i = 0; i < list.length; i++) {
      var nat = nativeGraphicInfo(list[i].clip);
      if (nat) out.push({ id: String(list[i].clip.nodeId), nativeGraphic: nat, warning: "Native Premiere graphic: text is not editable by script." });
      else out.push({ id: String(list[i].clip.nodeId), result: setMogrtParams(list[i].clip, a.params) });
    }
    return { clips: out };
  };
  H.get_mogrt_params = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      var nat = nativeGraphicInfo(list[i].clip);
      if (nat) out.push({ id: String(list[i].clip.nodeId), nativeGraphic: nat });
      else out.push({ id: String(list[i].clip.nodeId), params: listMogrtParams(list[i].clip) });
    }
    return { clips: out };
  };

  // ---- clip edits
  H.move_clips = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    if (!has(a, "delta") && !has(a, "to")) fail("BAD_ARGS", "Pass delta or to");
    requireUnlocked(withLinked(s, list, a.include_linked));
    // Each selected clip gets its delta; its linked clips (audio of a video
    // clip...) move by the same amount so they stay in sync.
    var jobs = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i].clip, id = String(c.nodeId);
      if (seen[id]) continue;
      var d = has(a, "delta") ? a.delta : a.to - tsec(c.start);
      var dt = snapTicks(s, secToTicks(d));
      if (parseFloat(c.start.ticks) + dt < -1) fail("BAD_ARGS", "Moving '" + c.name + "' by " + r3(d) + "s would put it before 0.");
      seen[id] = 1;
      jobs.push({ clip: c, ticks: dt, linked: false });
      if (a.include_linked !== false) {
        var ls = linkedEntries(s, c);
        for (var k = 0; k < ls.length; k++) { var lid = String(ls[k].clip.nodeId); if (!seen[lid]) { seen[lid] = 1; jobs.push({ clip: ls[k].clip, ticks: dt, linked: true }); } }
      }
    }
    // Move later clips first when shifting right (earlier first when shifting left) so they never collide.
    jobs.sort(function (x, y) { var dx = parseFloat(x.clip.start.ticks), dy = parseFloat(y.clip.start.ticks); return x.ticks > 0 ? dy - dx : dx - dy; });
    for (var j = 0; j < jobs.length; j++) {
      var jc = jobs[j].clip;
      jc.move(timeFromTicks(jobs[j].ticks));
      var o = { id: String(jc.nodeId), start: r3(tsec(jc.start)), end: r3(tsec(jc.end)) };
      if (jobs[j].linked) o.linked = true;
      out.push(o);
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
  // Trim one clip. On Premiere 26 TrackItem.start/end and inPoint/outPoint are
  // independent setters: moving an edge does not move the media in/out with it,
  // so both are kept in sync. Work in DOM units (speed-scaled), where out - in
  // equals the timeline duration. Returns a function that applies the edit, so
  // every clip of a linked group is validated before any of them changes.
  function planTrim(s, c, a) {
    var spd = clipSpeed(c);
    var st = tsec(c.start), en = tsec(c.end), cin = tsec(c.inPoint);
    var newStart = st, newEnd = en;
    if (has(a, "start")) newStart = a.start;
    if (has(a, "trim_start")) newStart = st + a.trim_start;
    if (has(a, "end")) newEnd = a.end;
    if (has(a, "duration")) newEnd = newStart + a.duration;
    if (has(a, "trim_end")) newEnd = en - a.trim_end;
    var newIn = cin + (newStart - st);
    if (has(a, "in")) newIn = a["in"] / spd;
    if (has(a, "out") && !has(a, "end") && !has(a, "duration") && !has(a, "trim_end")) newEnd = newStart + (a.out / spd - newIn);
    if (newStart < -0.0005) fail("BAD_ARGS", "Trim would move '" + c.name + "' before 0.");
    if (newEnd - newStart < 1 / fps(s) - 0.0005) fail("BAD_ARGS", "Trim would leave clip '" + c.name + "' shorter than one frame.");
    if (newIn < -0.0005) fail("BAD_ARGS", "Trim would move the in point of '" + c.name + "' before the start of its media.");
    var sT = seqTime(s, newStart), eT = seqTime(s, newEnd);
    var dur = ticksToSec(parseFloat(eT.ticks) - parseFloat(sT.ticks));
    // The media range must stay inside the file (stills have no length).
    var len = null;
    try { if (c.projectItem && !isStillItem(c.projectItem)) len = mediaLength(c.projectItem, null); } catch (eL) {}
    var mediaOut = (newIn + dur) * spd, slack = 0.5 / fps(s);
    if (len !== null && mediaOut > len + slack) fail("BAD_ARGS", "Trim would need media up to " + r3(mediaOut) + "s but '" + c.name + "' is " + r3(len) + "s long.", "Keep out <= the media length.");
    return function () {
      // Widen before narrowing so the edges never cross.
      if (newStart < st) { c.start = sT; c.end = eT; } else { c.end = eT; c.start = sT; }
      c.inPoint = timeFromSec(newIn);
      c.outPoint = timeFromSec(newIn + dur);
    };
  }
  H.trim_clips = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    var all = requireUnlocked(withLinked(s, list, a.include_linked));
    var apply = [];
    for (var i = 0; i < all.length; i++) apply.push(planTrim(s, all[i].clip, a));
    for (var k = 0; k < all.length; k++) {
      apply[k]();
      var info = clipInfo(all[k].clip, all[k].track, all[k].index, {});
      info.duration = r3(tsec(all[k].clip.end) - tsec(all[k].clip.start));
      if (all[k].linkedTo) info.linked = true;
      out.push(info);
    }
    return { clips: out };
  };
  H.remove_clips = function (a) {
    var s = getSequence(a.sequence), list = requireUnlocked(withLinked(s, requireClips(s, a.clips), a.include_linked)), out = [];
    // remove from the end backwards so indices / ripples stay valid
    list.sort(function (x, y) { return tsec(y.clip.start) - tsec(x.clip.start); });
    for (var i = 0; i < list.length; i++) {
      var o = { id: String(list[i].clip.nodeId), name: list[i].clip.name, track: list[i].track };
      if (list[i].linkedTo) o.linked = true;
      out.push(o);
      list[i].clip.remove(!!a.ripple, a.align_to_video !== false);
    }
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
    var s = getSequence(a.sequence), list = requireClips(s, a.clips);
    // unlinkSelection/linkSelection act on the timeline selection, which must
    // hold every clip of the group: selecting only the video clip of a linked
    // pair made unlink return false and change nothing.
    var group = a.unlink ? withLinked(s, list, true) : list;
    if (!a.unlink && group.length < 2) fail("BAD_ARGS", "Pass at least two clips to link (e.g. a video clip and an audio clip).");
    var all = selectClips(s, {});
    for (var j = 0; j < all.length; j++) try { all[j].clip.setSelected(false, true); } catch (e) {}
    for (var i = 0; i < group.length; i++) group[i].clip.setSelected(true, true);
    var ok = a.unlink ? s.unlinkSelection() : s.linkSelection();
    for (var k = 0; k < group.length; k++) try { group[k].clip.setSelected(false, true); } catch (e2) {}
    // Verify by reading the links back.
    var first = findClip(s, group[0].clip.nodeId), n = 0;
    try { var l = first.clip.getLinkedItems(); n = l ? l.numItems : 0; } catch (e3) {}
    var done = a.unlink ? n <= 1 : n >= group.length;
    if (!done) fail("LINK_FAILED", "Premiere did not " + (a.unlink ? "unlink" : "link") + " the clips (returned " + ok + ").", a.unlink ? "" : "Linking needs clips that overlap in time, at most one video clip and audio on different tracks.");
    var ids = [];
    for (var q = 0; q < group.length; q++) ids.push(String(group[q].clip.nodeId));
    return { linked: !a.unlink, ok: true, clips: ids };
  };
  H.razor = function (a) {
    var s = getSequence(a.sequence), qs = qeSequenceFor(s);
    var times = asArray(a.times), tracks = a.tracks ? asArray(a.tracks) : null, cuts = 0, done = [], skipped = [];
    // Count only clips that really get split: a clip must span the time
    // (strictly inside it) on a track that is cut.
    var linked = a.include_linked !== false;
    function spanning(trackObj, ticks) {
      var clips = trackObj.clips, at = lowerBoundClip(clips, ticks);
      for (var i = Math.max(0, at - 1); i >= 0 && i < clips.numItems && i <= at; i++) {
        var cs = parseFloat(clips[i].start.ticks), ce = parseFloat(clips[i].end.ticks);
        if (cs < ticks - 1 && ce > ticks + 1) return clips[i];
      }
      return null;
    }
    function isLocked(trackObj) { try { return !!trackObj.isLocked(); } catch (e) { return false; } }
    var targets = [];
    if (tracks) for (var j = 0; j < tracks.length; j++) { var t = parseTrackRef(tracks[j]); targets.push({ t: t, obj: getTrack(s, tracks[j], false).track }); }
    else {
      for (var v = 0; v < s.videoTracks.numTracks; v++) targets.push({ t: { video: true, index: v }, obj: s.videoTracks[v] });
      for (var au = 0; au < s.audioTracks.numTracks; au++) targets.push({ t: { video: false, index: au }, obj: s.audioTracks[au] });
    }
    if (tracks) for (var lk = 0; lk < targets.length; lk++) if (isLocked(targets[lk].obj)) fail("TRACK_LOCKED", trackLabel(targets[lk].t.video, targets[lk].t.index) + " is locked.", "Unlock it with manage_tracks action 'set' lock: false.");
    for (var i = 0; i < times.length; i++) {
      if (!isNum(times[i]) || times[i] < 0) fail("BAD_ARGS", "Razor times must be >= 0 (got " + times[i] + ").");
      var ticks = snapTicks(s, secToTicks(times[i])), tc = timecodeFor(s, ticks), n = 0, counted = {};
      for (var k = 0; k < targets.length; k++) {
        var hit = spanning(targets[k].obj, ticks);
        if (!hit || counted[String(hit.nodeId)]) continue;
        counted[String(hit.nodeId)] = 1; n++;
        // Linked partners on other tracks are cut too (QE's first razor flag).
        if (linked && tracks) { var ls = linkedEntries(s, hit); for (var q = 0; q < ls.length; q++) { var lid = String(ls[q].clip.nodeId), lc = ls[q].clip; if (!counted[lid] && parseFloat(lc.start.ticks) < ticks - 1 && parseFloat(lc.end.ticks) > ticks + 1) { counted[lid] = 1; n++; } } }
      }
      if (!n) { skipped.push(times[i]); continue; }
      if (!tracks) qs.razor(tc, true, true);
      else for (var m = 0; m < targets.length; m++) {
        var tt = targets[m].t;
        var qt = tt.video ? qs.getVideoTrackAt(tt.index) : qs.getAudioTrackAt(tt.index);
        qt.razor(tc, linked, true);
      }
      cuts += n;
      done.push(times[i]);
    }
    var res = { cuts: cuts, times: done };
    if (skipped.length) {
      res.skipped = skipped;
      res.warning = "No clip spans " + skipped.join(", ") + "s on " + (tracks ? "the given tracks" : "any track") + " (sequence ends at " + r3(parseFloat(s.end) / TPS) + "s); nothing was cut there.";
    }
    return res;
  };
  function isStillItem(it) {
    try { return /\.(png|jpe?g|tiff?|psd|bmp|gif|webp|ai|svg|exr|tga)$/.test(lower(itemMediaPath(it))); } catch (e) { return false; }
  }
  function clipSpeed(c) {
    var sp = 1;
    try { sp = c.getSpeed(); } catch (e) {}
    if (!(sp > 0)) sp = 1;
    if (sp > 10) sp = sp / 100; // older hosts report percent
    return sp;
  }
  // Change the speed of one timeline clip through QE and leave it showing the
  // same media range at the new speed.
  function setSpeedOn(s, e, a) {
    var c = e.clip, startTicks = parseFloat(c.start.ticks);
    var oldSpeed = clipSpeed(c);
    // DOM in/out are in speed-scaled units; convert to real media seconds.
    var mediaIn = tsec(c.inPoint) * oldSpeed;
    var tlDur = tsec(c.end) - tsec(c.start);
    var mediaDur = tlDur * oldSpeed;
    var fr = fps(s), nominal = Math.round(fr), frames = Math.max(1, Math.round(mediaDur / a.speed * fr));
    var tc = pad2(Math.floor(frames / (nominal * 3600))) + ":" + pad2(Math.floor(frames / (nominal * 60)) % 60) + ":" + pad2(Math.floor(frames / nominal) % 60) + ":" + pad2(frames % nominal);
    // QE computes the new speed from the media left after the in point. On a
    // razored piece that ends at the end of its media it lands short (1.333,
    // then 1.6, 1.778... for speed 2). Moving the source range to the start of
    // the media first gives QE room; the real range is put back afterwards.
    var shift = mediaIn > 0.0005 && !isStillItem(c.projectItem);
    // Ripple is done here: QE's own ripple flag does nothing on 26.x. Clips
    // after this one on the same track move by the change in length (made room
    // for first when the clip grows).
    var oldEndTicks = parseFloat(c.end.ticks), predictedEnd = startTicks + frames * frameTicks(s);
    var grow = predictedEnd - oldEndTicks;
    if (a.ripple && grow > 1) shiftFollowers(e.trackObj, oldEndTicks, grow, String(c.nodeId));
    if (shift) { c.inPoint = timeFromSec(0); c.outPoint = timeFromSec(tlDur); }
    var fresh = c, sp = null;
    for (var tries = 0; tries < 3; tries++) {
      var qc = qeClipFor(s, { clip: fresh, track: e.track, video: e.video });
      qc.setSpeed(a.speed, tc, !!a.reverse, false, !!a.maintain_pitch);
      fresh = findPlacedClip(e.trackObj, startTicks, null, 2) || fresh;
      sp = null;
      try { sp = fresh.getSpeed(); } catch (ee) {}
      if (sp !== null && Math.abs(sp - a.speed) < 0.001) break;
    }
    if (shift || (sp !== null && Math.abs(sp - a.speed) < 0.001)) {
      var spd = sp > 0 ? sp : a.speed, newDur = tsec(fresh.end) - tsec(fresh.start);
      fresh.inPoint = timeFromSec(mediaIn / spd);
      fresh.outPoint = timeFromSec(mediaIn / spd + newDur);
    }
    if (a.ripple) {
      // Close the gap (or fix the room made) using the real new end.
      var newEndTicks = parseFloat(fresh.end.ticks), fix = newEndTicks - (grow > 1 ? predictedEnd : oldEndTicks);
      if (Math.abs(fix) > 1) shiftFollowers(e.trackObj, grow > 1 ? predictedEnd : oldEndTicks, fix, String(fresh.nodeId));
    }
    var info = clipInfo(fresh, e.track, -1, {});
    delete info.index;
    info.speed = sp;
    if (sp === null || Math.abs(sp - a.speed) >= 0.001) info.warning = "Premiere settled on speed " + sp + " instead of " + a.speed;
    return info;
  }
  // Move every clip on a track that starts at or after fromTicks by deltaTicks.
  function shiftFollowers(trackObj, fromTicks, deltaTicks, excludeId) {
    var clips = trackObj.clips, list = [];
    for (var i = lowerBoundClip(clips, fromTicks - 2); i < clips.numItems; i++) if (String(clips[i].nodeId) !== excludeId) list.push(clips[i]);
    if (deltaTicks > 0) list.reverse(); // move the last one first so none collide
    for (var k = 0; k < list.length; k++) list[k].move(timeFromTicks(deltaTicks));
    return list.length;
  }
  H.set_speed = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [], linkedOut = [], done = {};
    if (!(a.speed > 0) || a.speed > 100) fail("BAD_ARGS", "speed must be > 0 and <= 100 (got " + a.speed + ").");
    requireUnlocked(withLinked(s, list, a.include_linked));
    var withLinkedFlag = a.include_linked !== false;
    // Collect the linked partners first: QE edits can leave TrackItem objects stale.
    var work = [];
    for (var i = 0; i < list.length; i++) {
      var id = String(list[i].clip.nodeId);
      if (done[id]) continue;
      done[id] = 1;
      work.push({ entry: list[i], linked: false });
      if (!withLinkedFlag) continue;
      var l = null;
      try { l = list[i].clip.getLinkedItems(); } catch (eL) {}
      if (l) for (var k = 0; k < l.numItems; k++) {
        var lid = String(l[k].nodeId);
        if (done[lid]) continue;
        done[lid] = 1;
        work.push({ id: lid, linked: true });
      }
    }
    for (var w = 0; w < work.length; w++) {
      var e = work[w].entry || findClip(s, work[w].id);
      if (!e) continue;
      if (work[w].entry) e = findClip(s, e.clip.nodeId) || e;
      var info = setSpeedOn(s, e, a);
      if (work[w].linked) linkedOut.push(info); else out.push(info);
    }
    return { clips: out, linked: linkedOut };
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
  // Re-read a clip from its sequence: TrackItem objects can go stale after QE edits
  // (their component list stops updating), which made every added effect look
  // like the first one and sent parameters to the wrong effect.
  function refreshEntry(seq, entry) {
    var id = String(entry.clip.nodeId);
    // Look on the clip's own track first (binary search by start): rescanning
    // the whole sequence for every effect made batches quadratic.
    if (entry.trackObj) {
      try {
        var clips = entry.trackObj.clips, st = parseFloat(entry.clip.start.ticks), at = lowerBoundClip(clips, st - 2);
        for (var i = Math.max(0, at - 1); i < clips.numItems && i <= at + 2; i++) if (String(clips[i].nodeId) === id) { entry.clip = clips[i]; return entry; }
      } catch (eT) {}
    }
    var f = findClip(seq, id);
    if (f) { entry.clip = f.clip; entry.trackObj = f.trackObj; }
    return entry;
  }
  function compKey(c) { var m = ""; try { m = String(c.matchName); } catch (e) {} return m || String(c.displayName); }
  // Add an effect through QE and return the component it created.
  var _qeFxCache = {};
  function addEffect(seq, entry, kind, name, matchName) {
    refreshEntry(seq, entry);
    // Premiere inserts a new effect right after the built-in ones, not at the
    // end, so the new component is found by comparing with what was there.
    var comps0 = entry.clip.components, n0 = comps0.numItems, before = {}, beforeKeys = [];
    for (var i = 0; i < n0; i++) { var k0 = compKey(comps0[i]); beforeKeys.push(k0); before[k0] = (before[k0] || 0) + 1; }
    var qc = qeClipFor(seq, entry);
    var fxKey = kind + "|" + name, fx = _qeFxCache[fxKey];
    if (!fx) fx = _qeFxCache[fxKey] = qeObject(kind, name);
    if (entry.video) qc.addVideoEffect(fx); else qc.addAudioEffect(fx);
    refreshEntry(seq, entry);
    var comps = entry.clip.components, n1 = comps.numItems;
    if (n1 <= n0) return null;
    // 0) Premiere 26 inserts the new effect at the top of the effect stack, i.e.
    // right after the built-in components. Take that slot when the lists agree
    // (after minus that slot == before); with two copies of the same effect a
    // count-based match would pick the old one.
    if (n1 === n0 + 1) {
      var p0 = 0;
      while (p0 < n1 && isBuiltIn(comps[p0])) p0++;
      if (p0 < n1) {
        var cand = comps[p0], ck = compKey(cand);
        if ((matchName && ck === matchName) || normName(cand.displayName) === normName(name) || (!matchName && !before[ck])) {
          var same = true;
          for (var z = 0, b = 0; z < n1 && same; z++) { if (z === p0) continue; if (compKey(comps[z]) !== beforeKeys[b]) same = false; b++; }
          if (same) return cand;
        }
      }
    }
    // 1) a component with the expected match name beyond the ones that existed
    var seen = {};
    for (var j = 0; j < n1; j++) {
      var c = comps[j], k = compKey(c);
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] > (before[k] || 0) && ((matchName && k === matchName) || normName(c.displayName) === normName(name))) return c;
    }
    // 2) any component kind that grew in count
    seen = {};
    for (var q = 0; q < n1; q++) { var c2 = comps[q], k2 = compKey(c2); seen[k2] = (seen[k2] || 0) + 1; if (seen[k2] > (before[k2] || 0)) return c2; }
    return comps[n1 - 1];
  }
  // Fast path for effects without parameters: one QE pass per track maps clips
  // by start, the effect is added through QE and checked by the QE component
  // count (no DOM component scans, which cost ~80 ms per clip).
  function applyEffectsFast(seq, list, effects) {
    var qs = qeSequenceFor(seq), maps = {}, results = [], fxCache = {};
    function mapFor(e) {
      if (maps[e.track]) return maps[e.track];
      var idx = trackIndexOf(seq, e), qt = e.video ? qs.getVideoTrackAt(idx) : qs.getAudioTrackAt(idx), m = {};
      for (var i = 0; i < qt.numItems; i++) { var q = qt.getItemAt(i); if (String(q.type) === "Clip") m[String(Math.round(parseFloat(q.start.ticks) / 1000))] = q; }
      maps[e.track] = m;
      return m;
    }
    var sample = null;
    for (var e = 0; e < effects.length; e++) {
      var spec = typeof effects[e] === "string" ? { name: effects[e] } : effects[e];
      for (var i = 0; i < list.length; i++) {
        var entry = list[i], kind = entry.video ? "video" : "audio", key = kind + "|" + spec.name;
        if (!fxCache[key]) { var nm = resolveCatalogName(kind, spec.name); fxCache[key] = { name: nm, obj: qeObject(kind, nm) }; }
        var fx = fxCache[key], qi = mapFor(entry)[String(Math.round(parseFloat(entry.clip.start.ticks) / 1000))];
        if (!qi) qi = qeClipFor(seq, entry);
        var n0 = qi.numComponents;
        if (entry.video) qi.addVideoEffect(fx.obj); else qi.addAudioEffect(fx.obj);
        var ok = qi.numComponents > n0;
        if (ok && !sample) sample = { entry: entry, name: fx.name };
        results.push({ id: String(entry.clip.nodeId), effect: fx.name, added: ok });
      }
    }
    // Real component / match name, read once from the DOM.
    if (sample) {
      try {
        refreshEntry(seq, sample.entry);
        var cs = sample.entry.clip.components, p0 = 0;
        while (p0 < cs.numItems && isBuiltIn(cs[p0])) p0++;
        if (p0 < cs.numItems) for (var r = 0; r < results.length; r++) if (results[r].added && results[r].effect === sample.name) { results[r].effect = cs[p0].displayName; results[r].matchName = compKey(cs[p0]); }
      } catch (eS) {}
    }
    return results;
  }
  function applyEffectsTo(seq, list, effects, cache) {
    var plain = !cache;
    for (var pe = 0; pe < effects.length && plain; pe++) if (typeof effects[pe] !== "string" && effects[pe].params) plain = false;
    if (plain && list.length > 2) return applyEffectsFast(seq, list, effects);
    var results = [], names = {};
    function nameFor(kind, wanted) {
      if (cache) return cache.effect(kind, wanted);
      var k = kind + "|" + wanted;
      if (!names.hasOwnProperty(k)) names[k] = resolveCatalogName(kind, wanted);
      return names[k];
    }
    for (var e = 0; e < effects.length; e++) {
      var spec = typeof effects[e] === "string" ? { name: effects[e] } : effects[e];
      for (var i = 0; i < list.length; i++) {
        var entry = list[i], kind = entry.video ? "video" : "audio";
        var name = nameFor(kind, spec.name);
        var comp = addEffect(seq, entry, kind, name, null);
        var r = { id: String(entry.clip.nodeId), effect: comp ? comp.displayName : name, matchName: comp ? compKey(comp) : undefined, added: !!comp };
        if (comp && spec.params) {
          var set = [];
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
    if (isBlendProp(p)) v = blendModeValue(v);
    if (has(spec, "time")) {
      var base = keyBase(entry.clip);
      if (!p.isTimeVarying()) p.setTimeVarying(true);
      var t = keyTime(base, spec.time);
      p.addKey(t);
      applyValueAtKey(p, t, v);
      var kv = null;
      try { kv = p.getValueAtKey(t); if (typeof kv === "number") kv = r3x(kv); else if (kv instanceof Array) { var ka = []; for (var q = 0; q < kv.length; q++) ka.push(typeof kv[q] === "number" ? r3x(kv[q]) : kv[q]); kv = ka; } } catch (eK) { kv = v; }
      return { effect: comp.displayName, property: p.displayName, value: kv, time: spec.time, keyframe: true };
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
  // Opacity > Blend Mode values. Found by rendering every index over a known
  // background on Premiere 26.5: the list is the English names in alphabetical
  // order, with Subtract and Divide appended.
  var BLEND_MODES = {
    color: 0, colorburn: 1, colordodge: 2, darken: 3, darkercolor: 4, difference: 5, dissolve: 6, exclusion: 7, hardlight: 8,
    hardmix: 9, hue: 10, lighten: 11, lightercolor: 12, linearburn: 13, lineardodge: 14, add: 14, lineardodgeadd: 14, linearlight: 15,
    luminosity: 16, multiply: 17, normal: 18, overlay: 19, pinlight: 20, saturation: 21, screen: 22, softlight: 23, vividlight: 24,
    subtract: 25, divide: 26,
    // pt-BR UI names
    cor: 0, subexposicaodecores: 1, superexposicaodecores: 2, escurecer: 3, cormaisescura: 4, diferenca: 5, dissolver: 6, exclusao: 7,
    luzdireta: 8, misturaabrupta: 9, matiz: 10, clarear: 11, cormaisclara: 12, subexposicaolinear: 13, superexposicaolinear: 14, adicionar: 14,
    luzlinear: 15, luminosidade: 16, multiplicacao: 17, multiplicar: 17, sobrepor: 19, luzdepino: 20, saturacao: 21, tela: 22, luzsuave: 23, luzintensa: 24,
    subtrair: 25, dividir: 26
  };
  var BLEND_NAMES = ["color", "color burn", "color dodge", "darken", "darker color", "difference", "dissolve", "exclusion", "hard light", "hard mix", "hue", "lighten", "lighter color", "linear burn", "linear dodge (add)", "linear light", "luminosity", "multiply", "normal", "overlay", "pin light", "saturation", "screen", "soft light", "vivid light", "subtract", "divide"];
  function stripAccents(s) { return String(s).replace(/[áàâã]/g, "a").replace(/[éê]/g, "e").replace(/[í]/g, "i").replace(/[óôõ]/g, "o").replace(/[ú]/g, "u").replace(/[ç]/g, "c"); }
  function blendModeValue(v) {
    if (typeof v === "number") { if (v < 0 || v >= BLEND_NAMES.length || Math.floor(v) !== v) fail("BAD_VALUE", "Blend mode index must be 0-" + (BLEND_NAMES.length - 1) + "."); return v; }
    var k = stripAccents(lower(v)).replace(/[^a-z]/g, "");
    if (!BLEND_MODES.hasOwnProperty(k)) fail("BAD_VALUE", "Unknown blend mode '" + v + "'.", "Use one of: " + BLEND_NAMES.join(", ") + ".");
    return BLEND_MODES[k];
  }
  function isBlendProp(p) { var n = normName(stripAccents(p.displayName)); return n === "blendmode" || n === "mododemesclagem" || n === "mododemistura"; }
  // Friendly transform: scale %, position px (or normalized with unit "norm"), rotation deg, anchor px, opacity %, crop %.
  function applyTransform(seq, entry, tr) {
    var c = entry.clip, done = {}, fresh = !!entry._fresh;
    if (!entry.video) fail("BAD_ARGS", "Transform needs a video clip");
    var motion = requireComponent(c, "AE.ADBE Motion");
    var fsz = frameSize(seq);
    function pos(v) { if (!(v instanceof Array)) fail("BAD_VALUE", "position must be [x, y]"); return tr.unit === "norm" ? v : [v[0] / fsz.w, v[1] / fsz.h]; }
    if (has(tr, "scale")) { applyValue(findProp(motion, "scale"), tr.scale, fresh); done.scale = tr.scale; }
    if (has(tr, "scale_width")) { var u = findProp(motion, "uniformscale"); try { applyValue(u, false); } catch (e) {} applyValue(findProp(motion, "scalewidth"), tr.scale_width); done.scale_width = tr.scale_width; }
    if (has(tr, "position")) { applyValue(findProp(motion, "position"), pos(tr.position), fresh); done.position = tr.position; }
    if (has(tr, "rotation")) { applyValue(findProp(motion, "rotation"), tr.rotation, fresh); done.rotation = tr.rotation; }
    if (has(tr, "anchor")) { applyValue(findProp(motion, "anchor"), pos(tr.anchor), fresh); done.anchor = tr.anchor; }
    var crops = ["crop_left", "crop_top", "crop_right", "crop_bottom"], ck = ["cropleft", "croptop", "cropright", "cropbottom"];
    for (var i = 0; i < crops.length; i++) if (has(tr, crops[i])) {
      var cp = findProp(motion, ck[i]);
      if (!cp) fail("UNSUPPORTED", "This Premiere build has no Motion crop properties; use apply_effects Crop.");
      applyValue(cp, tr[crops[i]]); done[crops[i]] = tr[crops[i]];
    }
    if (has(tr, "opacity")) { var op = requireComponent(c, "AE.ADBE Opacity"); applyValue(op.properties[0], tr.opacity); done.opacity = tr.opacity; }
    if (has(tr, "blend_mode")) {
      var op2 = requireComponent(c, "AE.ADBE Opacity"), bv = blendModeValue(tr.blend_mode);
      if (op2.properties.numItems > 1) { applyValue(op2.properties[1], bv); done.blend_mode = BLEND_NAMES[bv]; }
    }
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
    var isMotion = MOTION_INDEX[normName(String(spec.property))] !== undefined && !spec.effect;
    if (!isMotion && p.areKeyframesSupported && !p.areKeyframesSupported()) fail("UNSUPPORTED", p.displayName + " cannot be keyframed");
    if (!entry._base || entry._base.clip !== c) entry._base = { clip: c, base: keyBase(c) };
    var base = entry._base.base, seq = null;
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
      if (interp && INTERP[interp] !== undefined) try { p.setInterpolationTypeAtKey(t, INTERP[interp], UPDATE_UI); } catch (e) {}
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
          dc = addEffect(s, dst, kind, name, compKey(sc));
          if (!dc) continue;
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
            comp = addEffect(s, entry, kind, name, fx.matchName);
            if (!comp) throw new Error("Premiere did not add " + name);
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
          var realMatch = "";
          try { realMatch = String(comp.matchName); } catch (eN) {}
          done.push({ effect: comp.displayName, matchName: realMatch, presetEffect: fx.displayName, params: setCount });
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
      var align = a.alignment === "center" ? 0.5 : (a.alignment === "end" ? 1 : (a.alignment === "start" ? 0 : 0.5));
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
  function setVolumeOn(entry, db, seq) {
    // A video clip has no Volume: set it on its linked audio instead.
    var targets = [entry];
    if (entry.video) {
      targets = [];
      var s0 = seq || app.project.activeSequence, ls = linkedEntries(s0, entry.clip);
      for (var i = 0; i < ls.length; i++) if (!ls[i].video) targets.push(ls[i]);
      if (!targets.length) fail("NO_AUDIO", "Clip '" + entry.clip.name + "' has no linked audio to set the volume on.");
    }
    for (var k = 0; k < targets.length; k++) {
      var p = volumeProp(targets[k].clip);
      if (p.isTimeVarying()) p.setTimeVarying(false);
      p.setValue(dbToLevel(db), true);
    }
    return targets;
  }
  // Audio clips of a selection: audio clips as they are, plus the linked audio
  // of selected video clips (unless include_linked is false).
  function audioTargets(s, list, include) {
    var out = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      var cand = list[i].video ? (include === false ? [] : linkedEntries(s, list[i].clip)) : [list[i]];
      for (var k = 0; k < cand.length; k++) { var id = String(cand[k].clip.nodeId); if (!cand[k].video && !seen[id]) { seen[id] = 1; out.push(cand[k]); } }
    }
    if (!out.length) fail("NO_AUDIO", "None of the selected clips has audio.", "Select audio clips, or video clips with linked audio.");
    return out;
  }
  H.set_volume = function (a) {
    if (!has(a, "db") && !a.keys) fail("BAD_ARGS", "Pass db (a level) or keys (an envelope).");
    if (has(a, "db") && !isNum(a.db)) fail("BAD_ARGS", "db must be a number.");
    var s = getSequence(a.sequence), list = audioTargets(s, requireClips(s, a.clips), a.include_linked), out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
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
    var s = getSequence(a.sequence), list = audioTargets(s, requireClips(s, a.clips), a.include_linked), out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
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
    var f = ensureParentFolder(a.path);
    s.exportAsFinalCutProXML(f.fsName, 1); // 1 = suppress the Translation Report dialog
    if (!new File(f.fsName).exists) fail("EXPORT_FAILED", "Premiere did not write " + f.fsName);
    return { path: f.fsName, exists: true };
  };
  H.export_edl = function (a) {
    var s = getSequence(a.sequence);
    var f = ensureParentFolder(a.path);
    if (typeof s.exportAsEDL !== "function") return { nativeExport: false, fallback: true };
    s.exportAsEDL(f.fsName, a.preset_path || "");
    if (!new File(f.fsName).exists) return { nativeExport: false, fallback: true };
    return { path: f.fsName, exists: true, nativeExport: true };
  };
  H.export_aaf = function (a) {
    var s = getSequence(a.sequence);
    ensureParentFolder(a.path);
    var ok = app.project.exportAAF(s, a.path, a.mixdown_video ? 1 : 0, a.explode_to_mono ? 1 : 0, a.sample_rate || 48000, a.bits || 16, a.embed_audio ? 1 : 0, 0, a.trim_sources ? 1 : 0, a.handle_frames || 0);
    return { path: a.path, ok: !!ok, exists: new File(a.path).exists };
  };
  function ensureParentFolder(p) {
    var f = new File(p), parent = f.parent;
    if (parent && !parent.exists) parent.create();
    if (parent && !parent.exists) fail("FOLDER_CREATE_FAILED", "Could not create the folder " + parent.fsName);
    return f;
  }
  H.export_media = function (a) {
    var s = getSequence(a.sequence), original = app.project.activeSequence;
    var preset = new File(a.preset_path);
    if (!preset.exists) fail("FILE_NOT_FOUND", "Export preset not found: " + a.preset_path, "Use list_export_presets.");
    var out = ensureParentFolder(a.path), requestedPath = out.fsName;
    // Encoders write the preset's own extension (an H.264 QuickTime preset makes
    // .mov even when asked for .mp4); use that name so the file can be found.
    var wantExt = "";
    try { wantExt = String(s.getExportFileExtension(preset.fsName) || "").replace(/^\./, ""); } catch (eX) {}
    if (wantExt) {
      var curExt = /\.([^.\\\/]+)$/.exec(out.fsName);
      if (!curExt || lower(curExt[1]) !== lower(wantExt)) out = new File(out.fsName.replace(/\.[^.\\\/]+$/, "") + "." + wantExt);
    }
    var range = a.range || "entire", src = s, temp = null, rangeInfo = null;
    // Sequence.exportAsMediaDirect ignores its range argument on Premiere 26.x and
    // always renders the whole sequence, so export a temporary subsequence instead.
    if (range !== "entire") {
      var savedIn = s.getInPointAsTime().seconds, savedOut = s.getOutPointAsTime().seconds;
      var rin, rout;
      if (range === "work_area") { rin = s.getWorkAreaInPointAsTime().seconds; rout = s.getWorkAreaOutPointAsTime().seconds; }
      else { rin = savedIn; rout = savedOut; }
      if (!(rin > -399999) || !(rout > rin)) fail("NO_RANGE", "The sequence has no " + (range === "in_out" ? "in/out points" : "work area") + " set.", "Set them with manage_sequence action 'range'.");
      // Where does content start inside the range? createSubsequence drops a
      // leading gap and ends at the last clip, so both edges are rebuilt below.
      var firstContent = null;
      eachClip(s, function (c) {
        var cs = tsec(c.start), ce = tsec(c.end);
        if (ce > rin + 0.0005 && cs < rout - 0.0005) { var st0 = cs > rin ? cs : rin; if (firstContent === null || st0 < firstContent) firstContent = st0; }
      });
      if (firstContent === null) fail("EMPTY_RANGE", "There is nothing on the timeline between " + r3(rin) + "s and " + r3(rout) + "s.");
      s.setInPoint(rin); s.setOutPoint(rout);
      temp = s.createSubsequence(true);
      try { if (savedIn > -399999) s.setInPoint(savedIn); else s.setInPoint(0); if (savedOut > -399999) s.setOutPoint(savedOut); } catch (eR) {}
      if (!temp) fail("SUBSEQUENCE_FAILED", "Could not isolate the export range.");
      temp.name = "_MCP export " + s.name;
      var leading = firstContent - rin, wantDur = rout - rin;
      var tempFirst = null, all = [];
      eachClip(temp, function (c) { all.push(c); var cs = tsec(c.start); if (tempFirst === null || cs < tempFirst) tempFirst = cs; });
      var shift = leading - (tempFirst || 0);
      if (shift > 0.0005) {
        all.sort(function (x, y) { return tsec(y.start) - tsec(x.start); });
        for (var k = 0; k < all.length; k++) all[k].move(timeFromTicks(snapTicks(temp, secToTicks(shift))));
      }
      var tempEnd = parseFloat(temp.end) / TPS;
      if (tempEnd < wantDur - 0.5 / fps(temp)) {
        if (!a.filler_path) fail("NO_FILLER", "The range ends with a gap and no filler image was provided.");
        var fillerItem = null, fbin = binByPath("_MCP Plus", true);
        for (var fi = 0; fi < fbin.children.numItems; fi++) if (fbin.children[fi].name === "mcp-filler.png") fillerItem = fbin.children[fi];
        if (!fillerItem) { var fimp = H.import_files({ paths: [a.filler_path], bin: "_MCP Plus" }); fillerItem = findItemByNodeId(fimp.imported[0].id); }
        addTracksQE(temp, 1, 0);
        var top = temp.videoTracks[temp.videoTracks.numTracks - 1];
        top.overwriteClip(fillerItem, 0);
        var filler = findPlacedClip(top, 0, fillerItem.nodeId, frameTicks(temp));
        if (filler) filler.end = seqTime(temp, wantDur);
      }
      src = temp;
      rangeInfo = { from: r3(rin), to: r3(rout), duration: r3(wantDur), leadingGap: r3(leading) };
    }
    var result;
    try {
      if (a.use_media_encoder) {
        var launched = false, lerr = "";
        try { launched = app.encoder.launchEncoder(); } catch (e) { lerr = String(e); }
        if (!launched) fail("AME_UNAVAILABLE", "Adobe Media Encoder could not be started" + (lerr ? " (" + lerr + ")" : "") + ".", "Install Adobe Media Encoder (same version as Premiere), or export without use_media_encoder.");
        if (temp) { try { temp.projectItem.moveBin(binByPath("_MCP Plus/Export ranges", true)); } catch (eM) {} }
        // AME reads the sequence from the saved project file: an unsaved
        // project makes encodeSequence throw "Unknown error exception".
        var proj = app.project;
        if (!proj.path) fail("PROJECT_NOT_SAVED", "Save the project once before exporting with Media Encoder.", "Use project_file action 'save_as'.");
        try { proj.save(); } catch (eS) {}
        if (!new File(proj.path).exists) fail("PROJECT_NOT_SAVED", "Premiere could not save the project to " + proj.path + "; Media Encoder needs the saved file.", "Use project_file action 'save_as' with a writable path.");
        var jobId = null, jerr = "";
        for (var attempt = 0; attempt < 3 && !jobId; attempt++) {
          try { jobId = app.encoder.encodeSequence(src, out.fsName, preset.fsName, app.encoder.ENCODE_ENTIRE !== undefined ? app.encoder.ENCODE_ENTIRE : 0, a.remove_on_completion ? 1 : 0); } catch (eE) { jerr = String(eE); }
          if (!jobId) $.sleep(3000); // AME may still be starting
        }
        if (!jobId || String(jobId) === "0") fail("AME_QUEUE_FAILED", "Adobe Media Encoder did not accept the job" + (jerr ? " (" + jerr + ")" : "") + ".", "Open Media Encoder once by hand, check the preset, then retry.");
        var started = false;
        if (a.start_queue !== false) try { started = !!app.encoder.startBatch(); } catch (e2) {}
        result = { queued: true, jobId: String(jobId), path: out.fsName, encoder: "Adobe Media Encoder", queueStarted: started, projectSaved: true };
        if (temp) { result.rangeSequence = temp.name; temp = null; }
      } else {
        var r = src.exportAsMediaDirect(out.fsName, preset.fsName, 0);
        // The call can return while the encoder is still flushing the file.
        // Wait until its size is stable before touching the source sequence.
        var wf = new File(out.fsName), lastSize = -1, stable = 0, waited = 0;
        while (waited < 600000 && stable < 6) {
          $.sleep(250); waited += 250;
          wf = new File(out.fsName);
          var sz = wf.exists ? wf.length : -1;
          if (sz > 0 && sz === lastSize) stable++; else stable = 0;
          lastSize = sz;
        }
        var written = new File(out.fsName).exists;
        if (!written) fail("EXPORT_FAILED", "Premiere did not write " + out.fsName + " (" + r + ").", "Save the project and keep the Premiere window visible, then retry.");
        result = { done: true, path: out.fsName, exists: true, bytes: new File(out.fsName).length };
        // Deleting the source sequence while the encoder still flushes truncates
        // the file, so the caller removes the temporary range sequence once the
        // file is verified (H.delete_sequence).
        if (temp && a.keep_temp) { result.tempSequence = String(temp.sequenceID); temp = null; }
      }
    } finally {
      if (temp) { try { app.project.deleteSequence(temp); } catch (eD) {} }
      try { if (original) activate(original); } catch (eA) {}
    }
    if (rangeInfo) result.range = rangeInfo;
    if (out.fsName !== requestedPath) { result.requestedPath = requestedPath; result.note = "The preset writes ." + wantExt + " files, so the output was named " + out.fsName + "."; }
    return result;
  };
  H.import_captions = function (a) {
    var s = getSequence(a.sequence);
    var imp = H.import_files({ paths: [a.path], bin: a.bin || "_MCP Plus/Captions" });
    if (!imp.imported.length) fail("IMPORT_FAILED", "Caption file was not imported");
    var item = findItemByNodeId(imp.imported[0].id);
    var fmt = a.format === "open" ? Sequence.CAPTION_FORMAT_OPEN : (a.format === "608" ? Sequence.CAPTION_FORMAT_608 : (a.format === "708" ? Sequence.CAPTION_FORMAT_708 : Sequence.CAPTION_FORMAT_SUBTITLE));
    var ok = s.createCaptionTrack(item, a.start || 0, fmt);
    return { ok: !!ok, item: imp.imported[0].id, bin: imp.imported[0].bin };
  };
  H.create_subsequence = function (a) {
    var s = getSequence(a.sequence);
    if (has(a, "in")) s.setInPoint(a["in"]);
    if (has(a, "out")) s.setOutPoint(a.out);
    var sub = s.createSubsequence(!!a.ignore_track_targeting);
    if (!sub) fail("SUBSEQUENCE_FAILED", "Premiere did not create the subsequence");
    if (a.name) sub.name = a.name;
    var res = summarizeSequence(sub);
    activate(s);
    res.activeSequence = { id: String(s.sequenceID), name: s.name };
    return res;
  };
  H.auto_reframe = function (a) {
    var s = getSequence(a.sequence);
    function countClips(q) { var n = 0; eachClip(q, function () { n++; }); return n; }
    var srcClips = countClips(s);
    if (!srcClips) fail("EMPTY_SEQUENCE", "Sequence '" + s.name + "' has no clips to reframe.", "Pass sequence with the name of the sequence to reframe (the active one was used).");
    var r = s.autoReframeSequence(a.numerator || 9, a.denominator || 16, a.motion_preset || "default", a.name || (s.name + " (reframed)"), a.use_nested_sequences !== false);
    if (!r) fail("REFRAME_FAILED", "Auto Reframe returned nothing.");
    // The new sequence is filled synchronously on 26.x; still wait briefly before declaring it empty.
    var got = countClips(r);
    for (var w = 0; w < 20 && !got; w++) { $.sleep(250); got = countClips(r); }
    if (!got) fail("REFRAME_FAILED", "Auto Reframe created '" + r.name + "' but it has no clips (source '" + s.name + "' has " + srcClips + ").");
    var res = summarizeSequence(r);
    res.source = { id: String(s.sequenceID), name: s.name, clips: srcClips };
    res.clips = got;
    if (a.activate) activate(r); else activate(s);
    res.activeSequence = { id: String(app.project.activeSequence.sequenceID), name: app.project.activeSequence.name };
    return res;
  };
  H.scene_edit_detection = function (a) {
    var s = getSequence(a.sequence);
    H.select_clips({ sequence: a.sequence, clips: a.clips });
    var sel = selectClips(s, a.clips || {}), beforeClips = {}, beforeMarkers = {};
    eachClip(s, function (c) { beforeClips[String(c.nodeId)] = true; });
    for (var i = 0; i < sel.length; i++) { try { var mk = sel[i].clip.projectItem.getMarkers(), m0 = mk.getFirstMarker(); while (m0) { beforeMarkers[sel[i].clip.projectItem.nodeId + "@" + m0.start.ticks] = true; m0 = mk.getNextMarker(m0); } } catch (eB) {} }
    var r = s.performSceneEditDetectionOnSelection(a.action === "cuts" ? "ApplyCuts" : "CreateMarkers", a.apply_to_linked_audio !== false, a.sensitivity === "low" ? "LowSensitivity" : (a.sensitivity === "high" ? "HighSensitivity" : "MediumSensitivity"));
    var res = { ok: !!r, action: a.action === "cuts" ? "cuts" : "markers" };
    if (a.action === "cuts") {
      var cuts = [], seenT = {}, times = [];
      eachClip(s, function (c, label) { if (!beforeClips[String(c.nodeId)]) cuts.push({ id: String(c.nodeId), track: label, start: r3(tsec(c.start)) }); });
      for (var k = 0; k < cuts.length; k++) if (!seenT[cuts[k].start]) { seenT[cuts[k].start] = 1; times.push(cuts[k].start); }
      times.sort(function (x, y) { return x - y; });
      res.newClips = cuts;
      res.cutTimes = times;
    } else {
      var marks = [], seen = {};
      for (var j = 0; j < sel.length; j++) {
        try {
          var pi = sel[j].clip.projectItem, ms = pi.getMarkers(), m = ms.getFirstMarker();
          var cin = tsec(sel[j].clip.inPoint), cst = tsec(sel[j].clip.start);
          while (m) {
            var key = pi.nodeId + "@" + m.start.ticks;
            if (!beforeMarkers[key] && !seen[key]) { seen[key] = 1; marks.push({ clip: String(sel[j].clip.nodeId), sourceTime: r3(tsec(m.start)), sequenceTime: r3(cst + tsec(m.start) - cin) }); }
            m = ms.getNextMarker(m);
          }
        } catch (eM) {}
      }
      res.markers = marks;
      res.note = "Scene markers are clip markers on the source items (sequenceTime assumes 100% speed).";
    }
    // What the server needs to fall back to FFmpeg scene detection.
    res.sources = sceneSources(s, sel);
    return res;
  };
  function sceneSources(s, sel) {
    var out = [];
    for (var i = 0; i < sel.length; i++) {
      var c = sel[i].clip, sp = clipSpeed(c), rev = false;
      try { rev = !!c.isSpeedReversed(); } catch (eR) {}
      var d = { id: String(c.nodeId), track: sel[i].track, video: sel[i].video, start: r3(tsec(c.start)), end: r3(tsec(c.end)), "in": r3(tsec(c.inPoint) * sp), out: r3(tsec(c.outPoint) * sp), speed: sp, reversed: rev, media: "" };
      try { d.media = itemMediaPath(c.projectItem); } catch (eM) {}
      var tracks = [sel[i].track];
      try { var l = c.getLinkedItems(); if (l) for (var k = 0; k < l.numItems; k++) { var f = findClip(s, l[k].nodeId); if (f && f.track !== sel[i].track) tracks.push(f.track); } } catch (eL) {}
      d.tracks = tracks;
      out.push(d);
    }
    return out;
  }
  H.scene_sources = function (a) { var s = getSequence(a.sequence); return { sources: sceneSources(s, selectClips(s, a.clips || {})) }; };


  // ================================================================ PHASE 2
  // ---- 2.1 inspection
  // Every timeline use of every project item: { nodeId: [{sequence, track, start}] }.
  function mediaUses() {
    var uses = {}, seqs = allSequences();
    for (var i = 0; i < seqs.length; i++) {
      var s = seqs[i];
      eachClip(s, function (c, label) {
        var pi = null;
        try { pi = c.projectItem; } catch (e) {}
        if (!pi) return;
        var id = String(pi.nodeId);
        if (!uses[id]) uses[id] = [];
        if (uses[id].length < 20) uses[id].push({ sequence: s.name, track: label, start: r3(tsec(c.start)) });
        else uses[id].more = (uses[id].more || 0) + 1;
      });
    }
    return uses;
  }
  function mediaItems() {
    var out = [];
    walk(requireProject().rootItem, "", function (it, path) {
      if (it.type === 2) return;
      var t = itemType(it);
      if (t === "sequence" || isHelperBin(path)) return;
      out.push({ it: it, path: path || "/" });
    });
    return out;
  }
  H.inspect_media = function (a) {
    var mode = a.mode || "used", uses = mediaUses(), items = mediaItems(), out = [], limit = a.limit || 200;
    if (mode === "duplicates") {
      var byPath = {};
      for (var i = 0; i < items.length; i++) {
        var mp = lower(itemMediaPath(items[i].it));
        if (!mp) continue;
        if (!byPath[mp]) byPath[mp] = [];
        byPath[mp].push(describeItem(items[i].it, items[i].path));
      }
      for (var k in byPath) if (byPath.hasOwnProperty(k) && byPath[k].length > 1) out.push({ media: byPath[k][0].media, items: byPath[k] });
      return { duplicates: out.slice(0, limit), count: out.length };
    }
    for (var j = 0; j < items.length; j++) {
      var it = items[j].it, id = String(it.nodeId), u = uses[id], off = false;
      try { off = !!it.isOffline(); } catch (eO) {}
      if (mode === "used" && !u) continue;
      if (mode === "unused" && u) continue;
      if (mode === "offline" && !off) continue;
      var d = describeItem(it, items[j].path);
      if (u) { d.uses = u.length + (u.more || 0); if (a.detail) d.where = u; }
      if (off) d.offline = true;
      out.push(d);
    }
    var res = { mode: mode, count: out.length, items: out.slice(0, limit) };
    if (out.length > limit) res.truncated = true;
    return res;
  };
  H.timeline_summary = function (a) {
    var s = getSequence(a.sequence), end = parseFloat(s.end) / TPS, tracks = [], fx = {}, disabled = [], offline = [], speed = [], gaps = [];
    var minGap = has(a, "min_gap") ? a.min_gap : 1 / fps(s) + 0.0005;
    var groups = [[s.videoTracks, true], [s.audioTracks, false]];
    for (var g = 0; g < groups.length; g++) {
      for (var t = 0; t < groups[g][0].numTracks; t++) {
        var tr = groups[g][0][t], label = trackLabel(groups[g][1], t), cov = 0, cursor = 0, n = tr.clips.numItems, tg = [];
        for (var i = 0; i < n; i++) {
          var c = tr.clips[i], cs = tsec(c.start), ce = tsec(c.end);
          cov += ce - cs;
          if (cs - cursor > minGap && (i > 0 || a.leading_gaps)) tg.push({ start: r3(cursor), end: r3(cs), duration: r3(cs - cursor) });
          if (ce > cursor) cursor = ce;
          try { if (c.disabled) disabled.push({ id: String(c.nodeId), name: c.name, track: label, start: r3(cs) }); } catch (e1) {}
          try { if (c.projectItem && c.projectItem.isOffline()) offline.push({ id: String(c.nodeId), name: c.name, track: label, start: r3(cs) }); } catch (e2) {}
          var sp = clipSpeed(c);
          if (Math.abs(sp - 1) > 0.0001) speed.push({ id: String(c.nodeId), name: c.name, track: label, speed: sp });
          try { for (var k = 0; k < c.components.numItems; k++) { var cp = c.components[k]; if (!isBuiltIn(cp)) fx[cp.displayName] = (fx[cp.displayName] || 0) + 1; } } catch (e3) {}
        }
        if (!n) continue;
        for (var q = 0; q < tg.length; q++) { tg[q].track = label; gaps.push(tg[q]); }
        tracks.push({ track: label, clips: n, coverage: end > 0 ? r3(cov / end) : 0, gaps: tg.length });
      }
    }
    var res = summarizeSequence(s);
    res.tracks = tracks;
    res.effects = fx;
    res.gaps = a.mode === "gaps" ? gaps : gaps.length;
    if (a.mode !== "gaps") { res.disabled = disabled; res.offline = offline; res.speedChanged = speed; }
    try { res.markers = s.markers.numMarkers; } catch (e4) {}
    if (a.mode === "gaps" || a.detail) res.gapList = gaps.slice(0, a.limit || 200);
    return res;
  };
  H.search_items = function (a) {
    var re = a.regex ? new RegExp(a.regex, "i") : null, q = a.name ? lower(a.name) : null;
    var exts = a.extensions ? asArray(a.extensions) : null, types = a.types ? asArray(a.types) : null;
    var uses = has(a, "used") ? mediaUses() : null, out = [], limit = a.limit || 200;
    walk(a.bin ? binByPath(a.bin, false) : requireProject().rootItem, a.bin || "", function (it, path) {
      var t = itemType(it);
      if (types && !inList(types, t)) return;
      if (q && lower(it.name).indexOf(q) < 0) return;
      if (re && !re.test(it.name)) return;
      var mp = itemMediaPath(it);
      if (exts) { var ok = false; for (var i = 0; i < exts.length; i++) if (lower(mp).match(new RegExp("\\." + String(exts[i]).replace(/^\./, "") + "$", "i"))) ok = true; if (!ok) return; }
      if (has(a, "label")) { var lb = -1; try { lb = it.getColorLabel(); } catch (e) {} if (lb !== a.label) return; }
      if (has(a, "offline")) { var off = false; try { off = !!it.isOffline(); } catch (e2) {} if (off !== !!a.offline) return; }
      if (uses && t !== "bin") { var used = !!uses[String(it.nodeId)]; if (used !== !!a.used) return; }
      if (out.length < limit) out.push(describeItem(it, path, !!a.detail));
      else out.truncated = true;
    });
    return { items: out, count: out.length, truncated: out.truncated || undefined };
  };
  function inList(list, v) { for (var i = 0; i < list.length; i++) if (list[i] === v) return true; return false; }
  H.inspect_state = function (a) {
    var res = H.ping({});
    try {
      var s = app.project.activeSequence;
      if (s) {
        res.sequence = summarizeSequence(s);
        var sel = selectClips(s, { selected: true }), ids = [];
        for (var i = 0; i < sel.length && i < 50; i++) ids.push({ id: String(sel[i].clip.nodeId), name: sel[i].clip.name, track: sel[i].track });
        res.selection = ids;
        var tv = [], ta = [];
        for (var v = 0; v < s.videoTracks.numTracks; v++) try { if (s.videoTracks[v].isTargeted()) tv.push("V" + (v + 1)); } catch (e1) {}
        for (var au = 0; au < s.audioTracks.numTracks; au++) try { if (s.audioTracks[au].isTargeted()) ta.push("A" + (au + 1)); } catch (e2) {}
        res.targeted = tv.concat(ta);
      }
      var vs = app.getProjectViewIDs ? app.getProjectViewIDs() : null;
      if (vs && vs.length) { var ps = app.getProjectViewSelection(vs[0]), list = []; if (ps) for (var k = 0; k < ps.length && k < 50; k++) list.push({ id: String(ps[k].nodeId), name: ps[k].name }); res.projectSelection = list; }
    } catch (e) {}
    return res;
  };
  // Clip details: effects with values/keyframes, linked clips, source item, markers of the item.
  H.inspect_clip = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    var fx = H.get_clip_effects({ sequence: a.sequence, clips: a.clips, include_values: a.detail !== false, limit: a.limit || 5 }).clips;
    for (var i = 0; i < list.length && i < (a.limit || 5); i++) {
      var c = list[i].clip, d = clipInfo(c, list[i].track, list[i].index, { media: true });
      var ls = linkedEntries(s, c), li = [];
      for (var k = 0; k < ls.length; k++) li.push({ id: String(ls[k].clip.nodeId), track: ls[k].track });
      d.linked = li;
      d.components = fx[i] ? fx[i].components : [];
      try { var pi = c.projectItem; if (pi) { d.itemName = pi.name; var ms = pi.getMarkers(); d.itemMarkers = ms ? ms.numMarkers : 0; } } catch (e) {}
      try { d.adjustmentLayer = !!c.isAdjustmentLayer(); d.mogrt = !!c.isMGT(); } catch (e2) {}
      out.push(d);
    }
    return { clips: out };
  };

  // ---- 2.11 metadata (XMP and project panel columns)
  var PROJ_NS = "http://ns.adobe.com/premierePrivateProjectMetaData/1.0/";
  function xmpLib() {
    if (typeof XMPMeta === "undefined") { try { if (ExternalObject.AdobeXMPScript === undefined) ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript"); } catch (e) {} }
    if (typeof XMPMeta === "undefined") fail("XMP_UNAVAILABLE", "The XMP scripting library is not available in this Premiere.");
  }
  // Friendly field names -> [namespace, property]. Log Note, Scene, Shot, Take,
  // Description and Good are the fields the Metadata panel shows for clips.
  function xmpField(name) {
    var n = normName(name);
    var map = {
      lognote: [XMPConst.NS_DM, "logComment"], logcomment: [XMPConst.NS_DM, "logComment"],
      scene: [XMPConst.NS_DM, "scene"], shot: [XMPConst.NS_DM, "shotName"], shotname: [XMPConst.NS_DM, "shotName"],
      take: [XMPConst.NS_DM, "takeNumber"], good: [XMPConst.NS_DM, "good"], description: [XMPConst.NS_DC, "description"],
      title: [XMPConst.NS_DC, "title"], creator: [XMPConst.NS_DC, "creator"], rating: [XMPConst.NS_XMP, "Rating"], comment: [XMPConst.NS_DM, "comment"]
    };
    return map[n] || null;
  }
  var SENSITIVE = /GPS|Serial|Owner|Creator|Author|Artist|Copyright|Lens|Make|Model|Location|City|Country|Email|Phone/i;
  function readXmp(it, includeSensitive) {
    xmpLib();
    var x = new XMPMeta(it.getXMPMetadata()), out = {}, hidden = 0;
    var iter = x.iterator(XMPConst.ITERATOR_JUST_LEAFNODES | XMPConst.ITERATOR_OMIT_QUALIFIERS);
    var n = 0;
    while (n < 400) {
      var p = iter.next();
      if (!p) break;
      n++;
      var path = String(p.path), v = String(p.value);
      if (!path || v === "") continue;
      if (!includeSensitive && SENSITIVE.test(path)) { hidden++; continue; }
      out[path] = v.length > 200 ? v.substring(0, 200) + "..." : v;
    }
    return { fields: out, hidden: hidden };
  }
  H.metadata = function (a) {
    var act = a.action || "get", items = asArray(a.items), out = [];
    if (act === "add_field") {
      var ok = requireProject().addPropertyToProjectMetadataSchema(a.field, a.field_label || a.field, has(a, "type") ? a.type : 2);
      return { field: a.field, added: !!ok };
    }
    if (!items.length) fail("BAD_ARGS", "Pass items (project item ids or names).");
    for (var i = 0; i < items.length; i++) {
      var it = resolveItem(items[i]), d = { id: String(it.nodeId), name: it.name };
      if (act === "get") {
        var r = readXmp(it, !!a.include_sensitive);
        var friendly = {};
        var names = ["Log Note", "Scene", "Shot", "Take", "Description", "Good"];
        xmpLib();
        var x0 = new XMPMeta(it.getXMPMetadata());
        for (var k = 0; k < names.length; k++) { var f = xmpField(names[k]); var pv = null; if (f[1] === "description" || f[1] === "title") { try { pv = x0.getLocalizedText(f[0], f[1], null, "x-default"); } catch (e1) {} } else { try { pv = x0.getProperty(f[0], f[1]); } catch (e0) {} } if (pv !== null && pv !== undefined && String(pv) !== "") friendly[names[k]] = String(pv); }
        d.fields = friendly;
        if (a.detail) { d.xmp = r.fields; if (r.hidden) d.hiddenSensitive = r.hidden; }
        try { var lb = it.getColorLabel(); d.label = lb; } catch (e2) {}
        if (a.fields) {
          var pm = new XMPMeta(it.getProjectMetadata()), custom = {};
          var fl = asArray(a.fields);
          for (var c = 0; c < fl.length; c++) { var cv = null; try { cv = pm.getProperty(PROJ_NS, fl[c]); } catch (e3) {} if (cv !== null && cv !== undefined) custom[fl[c]] = String(cv); }
          d.custom = custom;
        }
      } else if (act === "set") {
        xmpLib();
        var vals = a.values || {}, x = new XMPMeta(it.getXMPMetadata()), setx = [], custom2 = [], pm2 = null;
        for (var key in vals) {
          if (!vals.hasOwnProperty(key)) continue;
          var fx = xmpField(key);
          if (fx) {
            if (fx[1] === "description" || fx[1] === "title") x.setLocalizedText(fx[0], fx[1], null, "x-default", String(vals[key]));
            else if (fx[1] === "creator") { try { x.deleteProperty(fx[0], fx[1]); } catch (eD) {} x.appendArrayItem(fx[0], fx[1], String(vals[key]), 0, XMPConst.ARRAY_IS_ORDERED); }
            else x.setProperty(fx[0], fx[1], String(vals[key]));
            setx.push(key);
          } else {
            if (!pm2) pm2 = new XMPMeta(it.getProjectMetadata());
            pm2.setProperty(PROJ_NS, key, String(vals[key]));
            custom2.push(key);
          }
        }
        if (setx.length) it.setXMPMetadata(x.serialize());
        if (custom2.length) it.setProjectMetadata(pm2.serialize(), custom2);
        // verify
        var chk = new XMPMeta(it.getXMPMetadata()), bad = [];
        for (var s2 = 0; s2 < setx.length; s2++) {
          var f2 = xmpField(setx[s2]), got = null;
          try { got = (f2[1] === "description" || f2[1] === "title") ? chk.getLocalizedText(f2[0], f2[1], null, "x-default") : (f2[1] === "creator" ? chk.getArrayItem(f2[0], f2[1], 1) : chk.getProperty(f2[0], f2[1])); } catch (eG) {}
          if (String(got) !== String(vals[setx[s2]])) bad.push(setx[s2]);
        }
        d.set = setx.concat(custom2);
        if (bad.length) d.notVerified = bad;
      } else if (act === "label") {
        it.setColorLabel(a.label);
        d.label = it.getColorLabel();
      }
      out.push(d);
    }
    var res = { items: out };
    if (act !== "get") { var allOk = true; for (var z = 0; z < out.length; z++) if (out[z].notVerified || (act === "label" && out[z].label !== a.label)) allOk = false; res.verified = allOk; }
    return res;
  };

  // ---- 2.2 project and media
  H.media_items = function (a) {
    var out = [];
    var list = a.items ? asArray(a.items) : null;
    if (list) for (var i = 0; i < list.length; i++) { var it = resolveItem(list[i]); out.push(mediaRecord(it)); }
    else { var all = mediaItems(); for (var j = 0; j < all.length; j++) { var off = false; try { off = !!all[j].it.isOffline(); } catch (e) {} if (!a.offline_only || off) out.push(mediaRecord(all[j].it)); } }
    return { items: out };
  };
  function mediaRecord(it) {
    var d = describeItem(it, undefined, true);
    try { d.offline = !!it.isOffline(); } catch (e) {}
    try { d.canChangePath = !!it.canChangeMediaPath(); } catch (e2) {}
    return d;
  }
  H.media_action = function (a) {
    var act = a.action, items = asArray(a.items), out = [];
    if (act === "proxies_enable") { app.setEnableProxies(a.enabled ? 1 : 0); return { proxiesEnabled: !!app.getEnableProxies(), verified: !!app.getEnableProxies() === !!a.enabled }; }
    if (!items.length) fail("BAD_ARGS", "Pass items.");
    for (var i = 0; i < items.length; i++) {
      var it = resolveItem(items[i]), d = { id: String(it.nodeId), name: it.name };
      if (act === "set_offline") { it.setOffline(); d.offline = !!it.isOffline(); d.verified = d.offline; }
      else if (act === "relink") {
        var f = new File(a.paths ? a.paths[i] : a.path);
        if (!f.exists) fail("FILE_NOT_FOUND", "File not found: " + f.fsName);
        if (!it.canChangeMediaPath()) fail("CANNOT_RELINK", it.name + " cannot change its media path.");
        it.changeMediaPath(f.fsName, true);
        d.media = itemMediaPath(it);
        d.verified = lower(d.media) === lower(f.fsName);
      }
      else if (act === "attach_proxy") {
        var pf = new File(a.paths ? a.paths[i] : a.path);
        if (!pf.exists) fail("FILE_NOT_FOUND", "Proxy not found: " + pf.fsName);
        it.attachProxy(pf.fsName, a.hi_res ? 1 : 0);
        d.hasProxy = !!it.hasProxy(); d.proxy = it.getProxyPath(); d.verified = d.hasProxy;
      }
      else if (act === "detach_proxy") { it.detachProxy(); d.hasProxy = !!it.hasProxy(); d.verified = !d.hasProxy; }
      else if (act === "proxy_status") { d.hasProxy = !!it.hasProxy(); try { d.proxy = it.getProxyPath(); } catch (e) {} try { d.canProxy = !!it.canProxy(); } catch (e2) {} }
      else if (act === "interpret") {
        var fi = it.getFootageInterpretation();
        if (has(a, "fps")) fi.frameRate = a.fps;
        if (has(a, "par")) fi.pixelAspectRatio = a.par;
        if (has(a, "field")) fi.fieldType = { "default": -1, progressive: 0, upper: 1, lower: 2 }[a.field];
        if (has(a, "alpha")) fi.alphaUsage = { none: 0, straight: 1, premultiplied: 2, ignore: 3 }[a.alpha];
        if (has(a, "invert_alpha")) fi.invertAlpha = !!a.invert_alpha;
        it.setFootageInterpretation(fi);
        var g = it.getFootageInterpretation();
        d.interpretation = { fps: r3(g.frameRate), par: r3(g.pixelAspectRatio), field: g.fieldType, alpha: g.alphaUsage, invertAlpha: !!g.invertAlpha };
        d.verified = (!has(a, "fps") || Math.abs(g.frameRate - a.fps) < 0.01) && (!has(a, "par") || Math.abs(g.pixelAspectRatio - a.par) < 0.001);
      }
      else if (act === "scale_to_frame") { it.setScaleToFrameSize(); d.done = true; }
      else if (act === "color_space") {
        if (a.color_space) {
          var lst = it.getOverrideColorSpaceList ? it.getOverrideColorSpaceList : null, chosen = null, names = [];
          if (lst) for (var k = 0; k < lst.length; k++) { names.push(lst[k].name); if (lower(lst[k].name) === lower(a.color_space)) chosen = lst[k]; }
          if (!chosen) fail("BAD_ARGS", "Unknown color space '" + a.color_space + "'.", "Use one of: " + names.join(", "));
          it.setOverrideColorSpace(chosen);
        }
        var cs = it.getColorSpace(), oc = null;
        try { oc = it.getOriginalColorSpace().name; } catch (e3) {}
        d.colorSpace = cs.name; d.original = oc;
        if (a.color_space) d.verified = lower(cs.name) === lower(a.color_space);
      }
      else if (act === "input_lut") {
        var lf = new File(a.path);
        if (!lf.exists) fail("FILE_NOT_FOUND", "LUT not found: " + lf.fsName);
        var fi2 = it.getFootageInterpretation();
        fi2.setInputLUTFromFilePath(lf.fsName);
        it.setFootageInterpretation(fi2);
        try { d.inputLUT = it.getInputLUTID(); } catch (e4) {}
        d.verified = !!d.inputLUT;
      }
      else fail("BAD_ARGS", "Unknown media action " + act);
      out.push(d);
    }
    var allV = true, anyV = false;
    for (var z = 0; z < out.length; z++) if (out[z].verified !== undefined) { anyV = true; if (!out[z].verified) allV = false; }
    var res = { items: out };
    if (anyV) res.verified = allV;
    return res;
  };
  H.project_tools = function (a) {
    var p = requireProject(), act = a.action;
    if (act === "consolidate_duplicates") { var before = mediaItems().length; p.consolidateDuplicates(); return { before: before, after: mediaItems().length }; }
    if (act === "scratch_disks") {
      var types = { capture_video: ScratchDiskType.FirstVideoCaptureFolder, capture_audio: ScratchDiskType.FirstAudioCaptureFolder, previews_video: ScratchDiskType.FirstVideoPreviewFolder, previews_audio: ScratchDiskType.FirstAudioPreviewFolder, autosave: ScratchDiskType.FirstAutoSaveFolder, cc_libraries: ScratchDiskType.FirstCClibrariesFolder, capsule_media: ScratchDiskType.FirstCapsuleMediaFolder };
      var keys = a.types ? asArray(a.types) : ["previews_video", "previews_audio"], done = [];
      var folder = new Folder(a.path);
      if (!folder.exists) folder.create();
      for (var i = 0; i < keys.length; i++) { if (types[keys[i]] === undefined) fail("BAD_ARGS", "Unknown scratch disk type " + keys[i]); app.setScratchDiskPath(folder.fsName, types[keys[i]]); done.push(keys[i]); }
      return { path: folder.fsName, set: done };
    }
    if (act === "smart_bin") {
      var parent = a.bin ? binByPath(a.bin, true) : p.rootItem;
      parent.createSmartBin(a.name, a.query);
      var found = null;
      for (var k = 0; k < parent.children.numItems; k++) if (parent.children[k].name === a.name) found = parent.children[k];
      return { name: a.name, query: a.query, created: !!found, verified: !!found };
    }
    if (act === "consolidate_and_transfer") {
      var pm = app.projectManager, o = pm.options;
      var dest = new Folder(a.path);
      if (!dest.exists) dest.create();
      o.clipTransferOption = o.CLIP_TRANSFER_COPY;
      o.destinationPath = dest.fsName;
      o.excludeUnused = a.exclude_unused !== false;
      o.handleFrameCount = a.handle_frames || 0;
      o.includePreviews = false;
      o.includeConformedAudio = false;
      o.renameMedia = false;
      o.includeAllSequences = true;
      var r = pm.process(p);
      var errs = [];
      try { var e = pm.errors; if (e) for (var q = 0; q < e.length; q++) errs.push(String(e[q])); } catch (eE) {}
      return { destination: dest.fsName, result: r, errors: errs };
    }
    if (act === "create_bins") { var made = []; var bl = asArray(a.bins); for (var b = 0; b < bl.length; b++) { binByPath(bl[b], true); made.push(bl[b]); } return { bins: made }; }
    if (act === "structure") {
      var bins = [], counts = {};
      walk(p.rootItem, "", function (it, path) {
        if (it.type === 2) { bins.push((path ? path + "/" : "") + it.name); return; }
        var t = itemType(it), mp = lower(itemMediaPath(it)), ext = mp.replace(/^.*\./, "");
        var kind = t === "sequence" ? "sequence" : (/^(mp4|mov|mxf|avi|mkv|m4v|mts|r3d|braw|webm)$/.test(ext) ? "video" : (/^(wav|mp3|aif|aiff|m4a|aac|flac|ogg)$/.test(ext) ? "audio" : (/^(png|jpe?g|tiff?|psd|gif|bmp|webp|exr|tga|ai|svg)$/.test(ext) ? "image" : (/^(mogrt|aegraphic)$/.test(ext) || it.isMGT ? "graphic" : "other"))));
        counts[kind] = (counts[kind] || 0) + 1;
        if (a.with_items) bins.push({ id: String(it.nodeId), name: it.name, bin: path || "/", kind: kind });
      });
      return { bins: bins, counts: counts };
    }
    fail("BAD_ARGS", "Unknown project_tools action " + act);
  };
  H.import_special = function (a) {
    var p = requireProject(), f = new File(a.path), kind = a.kind;
    if (!f.exists) fail("FILE_NOT_FOUND", "File not found: " + f.fsName);
    var bin = a.bin ? binByPath(a.bin, true) : p.rootItem;
    var beforeSeq = {}, seqs0 = allSequences();
    for (var i = 0; i < seqs0.length; i++) beforeSeq[String(seqs0[i].sequenceID)] = 1;
    var beforeCount = 0;
    walk(p.rootItem, "", function () { beforeCount++; });
    var ok = null;
    if (kind === "ae_comps") {
      if (a.comps && a.comps.length) ok = p.importAEComps(f.fsName, a.comps, bin);
      else ok = p.importAllAEComps(f.fsName, bin);
    } else if (kind === "sequences") {
      if (!a.sequence_ids || !a.sequence_ids.length) fail("BAD_ARGS", "Pass sequence_ids (from list_project_sequences of that .prproj).");
      ok = p.importSequences(f.fsName, a.sequence_ids);
    } else {
      ok = p.importFiles([f.fsName], true, bin, false);
    }
    var seqs = allSequences(), newSeq = [];
    for (var j = 0; j < seqs.length; j++) if (!beforeSeq[String(seqs[j].sequenceID)]) newSeq.push({ id: String(seqs[j].sequenceID), name: seqs[j].name });
    var afterCount = 0;
    walk(p.rootItem, "", function () { afterCount++; });
    return { kind: kind, path: f.fsName, result: ok, newItems: afterCount - beforeCount, newSequences: newSeq, verified: afterCount > beforeCount };
  };


  // ---- 2.3 sequences
  H.sequence_from_clips = function (a) {
    var p = requireProject(), items = asArray(a.items), list = [];
    for (var i = 0; i < items.length; i++) list.push(resolveItem(items[i]));
    if (!list.length) fail("BAD_ARGS", "Pass items.");
    var before = {}, s0 = allSequences();
    for (var k = 0; k < s0.length; k++) before[String(s0[k].sequenceID)] = 1;
    var bin = a.bin ? binByPath(a.bin, true) : p.rootItem;
    p.createNewSequenceFromClips(a.name || list[0].name, list, bin);
    var seqs = allSequences(), made = null;
    for (var j = 0; j < seqs.length; j++) if (!before[String(seqs[j].sequenceID)]) made = seqs[j];
    if (!made) fail("SEQUENCE_CREATE_FAILED", "Premiere did not create the sequence.");
    var res = summarizeSequence(made), n = 0;
    eachClip(made, function () { n++; });
    res.clips = n;
    res.verified = n >= list.length;
    return res;
  };
  H.sequence_extra = function (a) {
    var s = getSequence(a.sequence), act = a.action, res = {};
    if (act === "zero_point") {
      s.setZeroPoint(String(secToTicks(a.seconds)));
      res.zeroPoint = r3(ticksToSec(parseFloat(s.zeroPoint)));
      res.verified = Math.abs(res.zeroPoint - a.seconds) < 0.001;
    } else if (act === "custom_property") {
      s.attachCustomProperty(a.name, String(a.value));
      res.attached = { name: a.name, value: String(a.value) };
    } else if (act === "format") {
      var st = s.getSettings();
      if (has(a, "display_format")) st.videoDisplayFormat = a.display_format;
      if (has(a, "field_type")) st.videoFieldType = a.field_type;
      if (has(a, "par")) st.videoPixelAspectRatio = String(a.par);
      if (has(a, "audio_channel_type")) st.audioChannelType = a.audio_channel_type;
      if (has(a, "audio_display_format")) st.audioDisplayFormat = a.audio_display_format;
      if (has(a, "max_bit_depth")) st.maximumBitDepth = !!a.max_bit_depth;
      if (has(a, "max_render_quality")) st.maximumRenderQuality = !!a.max_render_quality;
      s.setSettings(st);
      var g = s.getSettings();
      res = { displayFormat: g.videoDisplayFormat, fieldType: g.videoFieldType, par: g.videoPixelAspectRatio, audioChannelType: g.audioChannelType, maxBitDepth: g.maximumBitDepth, maxRenderQuality: g.maximumRenderQuality };
      res.verified = (!has(a, "display_format") || g.videoDisplayFormat === a.display_format) && (!has(a, "field_type") || g.videoFieldType === a.field_type);
    } else if (act === "render_previews") {
      var qs = qeSequenceFor(s);
      if (a.audio) qs.renderAudio(); else qs.renderAll();
      res.rendered = true;
    } else if (act === "delete_previews") {
      var qs2 = qeSequenceFor(s);
      qs2.deletePreviewFiles(timecodeFor(s, 0), timecodeFor(s, parseFloat(s.end)));
      res.deleted = true;
    } else fail("BAD_ARGS", "Unknown action " + act);
    return res;
  };
  // Nest: the selected clips' time range on their tracks becomes a nested sequence placed in their place.
  H.nest_clips = function (a) {
    var s = getSequence(a.sequence), list = requireUnlocked(withLinked(s, requireClips(s, a.clips), a.include_linked)), lo = Infinity, hi = -Infinity, vt = 99, tracks = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i].clip; lo = Math.min(lo, parseFloat(c.start.ticks)); hi = Math.max(hi, parseFloat(c.end.ticks));
      tracks[list[i].track] = 1;
      if (list[i].video) vt = Math.min(vt, parseTrackRef(list[i].track).index);
    }
    // Only the clips' tracks are copied into the nest.
    var saved = [];
    var groups = [[s.videoTracks, true], [s.audioTracks, false]];
    for (var g = 0; g < groups.length; g++) for (var t = 0; t < groups[g][0].numTracks; t++) {
      var tr = groups[g][0][t], lab = trackLabel(groups[g][1], t), was = false;
      try { was = tr.isTargeted(); } catch (e) {}
      saved.push({ tr: tr, was: was });
      try { tr.setTargeted(!!tracks[lab], true); } catch (e2) {}
    }
    var savedIn = null, savedOut = null;
    try { savedIn = tsec(s.getInPointAsTime()); savedOut = tsec(s.getOutPointAsTime()); } catch (eS) {}
    s.setInPoint(ticksToSec(lo)); s.setOutPoint(ticksToSec(hi));
    var before = {}, s0 = allSequences();
    for (var k = 0; k < s0.length; k++) before[String(s0[k].sequenceID)] = 1;
    s.createSubsequence(false);
    var seqs = allSequences(), sub = null;
    for (var j = 0; j < seqs.length; j++) if (!before[String(seqs[j].sequenceID)]) sub = seqs[j];
    for (var r = 0; r < saved.length; r++) try { saved[r].tr.setTargeted(saved[r].was, true); } catch (e3) {}
    try { if (savedIn !== null && savedIn > -399999) s.setInPoint(savedIn); if (savedOut !== null && savedOut > -399999) s.setOutPoint(savedOut); } catch (eR) {}
    activate(s);
    if (!sub) fail("NEST_FAILED", "Premiere did not create the nested sequence.");
    if (a.name) sub.name = a.name;
    // Remove the originals, then put the nest where they were.
    for (var m = list.length - 1; m >= 0; m--) { var f = findClip(s, list[m].clip.nodeId); if (f) f.clip.remove(false, true); }
    var vIdx = vt === 99 ? 0 : vt;
    var tgt = s.videoTracks[vIdx];
    tgt.overwriteClip(sub.projectItem, ticksToSec(lo));
    var placed = findPlacedClip(tgt, lo, null, 2);
    return { nested: { id: String(sub.sequenceID), name: sub.name }, start: r3(ticksToSec(lo)), end: r3(ticksToSec(hi)), clip: placed ? String(placed.nodeId) : null, removed: list.length, verified: !!placed };
  };
  // Unnest: put the clips of a nested sequence back on the parent timeline at the nest's offset.
  H.unnest_clip = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), done = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i], c = e.clip, pi = c.projectItem, inner = null;
      if (!pi || !pi.isSequence()) fail("NOT_A_NEST", "Clip '" + c.name + "' is not a nested sequence.");
      var seqs = allSequences();
      for (var k = 0; k < seqs.length; k++) if (String(seqs[k].projectItem.nodeId) === String(pi.nodeId)) inner = seqs[k];
      if (!inner) fail("NOT_A_NEST", "The nested sequence of '" + c.name + "' was not found.");
      var off = tsec(c.start) - tsec(c.inPoint), from = tsec(c.inPoint), to = tsec(c.outPoint), specs = [];
      var baseV = parseTrackRef(e.track).index, minV = 99;
      // Inner video tracks map so the lowest one used lands on the nest's track.
      eachClip(inner, function (ic, label, idx, tr, video) { if (video) minV = Math.min(minV, parseTrackRef(label).index); });
      if (minV === 99) minV = 0;
      eachClip(inner, function (ic, label, idx, tr, video) {
        var cs = tsec(ic.start), ce = tsec(ic.end);
        if (ce <= from + 0.0005 || cs >= to - 0.0005) return;
        var cut0 = Math.max(0, from - cs), cut1 = Math.max(0, ce - to), sp = clipSpeed(ic);
        var ref = parseTrackRef(label);
        var spec = { item: String(ic.projectItem.nodeId), track: trackLabel(video, video ? ref.index - minV + baseV : ref.index), start: r3(cs + cut0 + off), "in": r3((tsec(ic.inPoint) + cut0) * sp), out: r3((tsec(ic.outPoint) - cut1) * sp), media: video ? "video" : "audio" };
        specs.push(spec);
      });
      var linked = linkedEntries(s, c);
      for (var l = 0; l < linked.length; l++) linked[l].clip.remove(false, true);
      c.remove(false, true);
      var r = H.place_clips({ sequence: a.sequence, clips: specs, auto_create_tracks: true });
      done.push({ nest: inner.name, placed: r.placed.length, errors: r.errors });
    }
    var ok = true;
    for (var q = 0; q < done.length; q++) if (done[q].errors && done[q].errors.length) ok = false;
    return { unnested: done, verified: ok, note: "Effects applied to the nest clip or to the inner clips are not carried over; use copy_effects." };
  };

  // ---- 2.4 timeline editing
  function framesTc(s, seconds) {
    var fr = fps(s), nominal = Math.round(fr), neg = seconds < 0, frames = Math.round(Math.abs(seconds) * fr);
    var tc = pad2(Math.floor(frames / (nominal * 3600))) + ";" + pad2(Math.floor(frames / (nominal * 60)) % 60) + ";" + pad2(Math.floor(frames / nominal) % 60) + ";" + pad2(frames % nominal);
    return (neg ? "-" : "") + tc;
  }
  function clipSnap(c) { return { id: String(c.nodeId), start: r3(tsec(c.start)), end: r3(tsec(c.end)), "in": r3(tsec(c.inPoint) * clipSpeed(c)), out: r3(tsec(c.outPoint) * clipSpeed(c)) }; }
  // QE slip / slide / roll on each clip (and its linked clips for slip/slide).
  H.edit_qe = function (a) {
    var s = getSequence(a.sequence), act = a.action, list = requireClips(s, a.clips), out = [];
    if (!isNum(a.delta) || a.delta === 0) fail("BAD_ARGS", "delta (seconds, non zero) is required.");
    var all = act === "roll" ? list : withLinked(s, list, a.include_linked);
    requireUnlocked(all);
    for (var i = 0; i < all.length; i++) {
      var e = all[i], before = clipSnap(e.clip), startTicks = parseFloat(e.clip.start.ticks), qc = qeClipFor(s, e), ok;
      if (act === "slip") ok = qc.slip(framesTc(s, -a.delta), false);
      else if (act === "slide") ok = qc.slide(framesTc(s, a.delta), false);
      else if (act === "roll") ok = qc.roll(framesTc(s, a.delta), false, false);
      var now = findPlacedClip(e.trackObj, act === "slide" ? startTicks + secToTicks(a.delta) : startTicks, null, frameTicks(s) * 0.6) || findClip(s, before.id);
      var after = now ? clipSnap(now.clip || now) : null;
      var d = { id: before.id, track: e.track, before: before, after: after };
      if (after) {
        if (act === "slip") d.verified = Math.abs(after["in"] - before["in"] - a.delta) < 0.05 && Math.abs(after.start - before.start) < 0.01;
        if (act === "slide") d.verified = Math.abs(after.start - before.start - a.delta) < 0.05 && Math.abs(after["in"] - before["in"]) < 0.01;
        if (act === "roll") d.verified = Math.abs(after.end - before.end - a.delta) < 0.05;
      } else d.verified = false;
      out.push(d);
    }
    var v = true;
    for (var k = 0; k < out.length; k++) if (!out[k].verified) v = false;
    return { action: act, clips: out, verified: v };
  };
  // Remove time ranges with ripple, on all tracks or the given ones, in one call.
  H.ripple_delete_ranges = function (a) {
    var s = getSequence(a.sequence), ranges = asArray(a.ranges), qs = qeSequenceFor(s);
    if (!ranges.length) fail("BAD_ARGS", "Pass ranges [{start, end}].");
    var targets = [];
    if (a.tracks) { var tl = asArray(a.tracks); for (var t = 0; t < tl.length; t++) { var ref = parseTrackRef(tl[t]); targets.push({ video: ref.video, index: ref.index, obj: getTrack(s, tl[t], false).track }); } }
    else {
      for (var v = 0; v < s.videoTracks.numTracks; v++) targets.push({ video: true, index: v, obj: s.videoTracks[v] });
      for (var au = 0; au < s.audioTracks.numTracks; au++) targets.push({ video: false, index: au, obj: s.audioTracks[au] });
    }
    for (var lk = 0; lk < targets.length; lk++) { var locked = false; try { locked = targets[lk].obj.isLocked(); } catch (eL) {} if (locked && targets[lk].obj.clips.numItems) fail("TRACK_LOCKED", trackLabel(targets[lk].video, targets[lk].index) + " is locked."); }
    // Normalize: snap to frames, merge overlaps, process from the last range back.
    var rs = [];
    for (var i = 0; i < ranges.length; i++) {
      var st = snapTicks(s, secToTicks(ranges[i].start)), en = snapTicks(s, secToTicks(ranges[i].end));
      if (!(en > st)) fail("BAD_ARGS", "Range " + i + " has end <= start.");
      rs.push([st, en]);
    }
    rs.sort(function (x, y) { return x[0] - y[0]; });
    var merged = [];
    for (var m = 0; m < rs.length; m++) { if (merged.length && rs[m][0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], rs[m][1]); else merged.push(rs[m]); }
    var seqEnd0 = parseFloat(s.end), removedTotal = 0, removedClips = 0;
    for (var r = merged.length - 1; r >= 0; r--) {
      var a0 = merged[r][0], a1 = merged[r][1], len = a1 - a0;
      for (var k = 0; k < targets.length; k++) {
        var tr = targets[k].obj, qt = targets[k].video ? qs.getVideoTrackAt(targets[k].index) : qs.getAudioTrackAt(targets[k].index);
        // cut at both edges where a clip spans them
        var edges = [a1, a0];
        for (var ed = 0; ed < edges.length; ed++) {
          var cl = tr.clips, at = lowerBoundClip(cl, edges[ed]);
          for (var x = Math.max(0, at - 1); x < cl.numItems && x <= at; x++) { var cs = parseFloat(cl[x].start.ticks), ce = parseFloat(cl[x].end.ticks); if (cs < edges[ed] - 1 && ce > edges[ed] + 1) { qt.razor(timecodeFor(s, edges[ed]), false, true); break; } }
        }
        // remove clips inside, then pull the rest left
        var inside = [];
        for (var y = 0; y < tr.clips.numItems; y++) { var c = tr.clips[y], s0 = parseFloat(c.start.ticks), e0 = parseFloat(c.end.ticks); if (s0 >= a0 - 2 && e0 <= a1 + 2) inside.push(c); }
        for (var z = inside.length - 1; z >= 0; z--) { inside[z].remove(false, true); removedClips++; }
        shiftFollowers(tr, a1 - 2, -len, "");
      }
      removedTotal += len;
    }
    var res = { ranges: merged.length, removedSeconds: r3(ticksToSec(removedTotal)), removedClips: removedClips, durationBefore: r3(seqEnd0 / TPS), durationAfter: r3(parseFloat(s.end) / TPS) };
    res.verified = !a.tracks ? Math.abs((seqEnd0 - parseFloat(s.end)) - removedTotal) < frameTicks(s) * 1.5 || parseFloat(s.end) < seqEnd0 : true;
    return res;
  };
  H.edit_misc = function (a) {
    var s = getSequence(a.sequence), act = a.action, out = [];
    if (act === "batch_rename") {
      var list = requireClips(s, a.clips), pat = a.pattern || "{name} {n}";
      list.sort(function (x, y) { return tsec(x.clip.start) - tsec(y.clip.start) || (x.track < y.track ? -1 : 1); });
      for (var i = 0; i < list.length; i++) {
        var c = list[i].clip, n = (a.start_number || 1) + i;
        var name = pat.replace(/\{n(?::0?(\d+))?\}/g, function (m0, w) { var t = String(n); if (w) while (t.length < parseInt(w, 10)) t = "0" + t; return t; }).replace(/\{name\}/g, c.name).replace(/\{track\}/g, list[i].track);
        c.name = name;
        out.push({ id: String(c.nodeId), name: c.name, ok: c.name === name });
      }
      var okAll = true; for (var q = 0; q < out.length; q++) if (!out[q].ok) okAll = false;
      return { renamed: out, verified: okAll };
    }
    if (act === "ripple_trim") {
      // Trim one edge and pull/push the rest of the track (and linked tracks) by the same amount.
      var l2 = requireUnlocked(withLinked(s, requireClips(s, a.clips), a.include_linked)), res2 = [];
      var edge = a.edge || "end", d = a.delta;
      if (!isNum(d)) fail("BAD_ARGS", "delta (seconds) is required.");
      for (var k = 0; k < l2.length; k++) {
        var e = l2[k], cl = e.clip, oldEnd = parseFloat(cl.end.ticks), oldStart = parseFloat(cl.start.ticks), id = String(cl.nodeId);
        var spec = edge === "start" ? { trim_start: d } : { trim_end: -d };
        planTrim(s, cl, spec)();
        var fresh = findClip(s, id).clip;
        if (edge === "start") {
          // keep the clip's start where it was: move it back, shift followers by -d
          var sh = -snapTicks(s, secToTicks(d));
          shiftFollowers(e.trackObj, oldEnd - 2, sh, id);
          fresh.move(timeFromTicks(oldStart - parseFloat(fresh.start.ticks)));
        } else shiftFollowers(e.trackObj, oldEnd - 2, parseFloat(fresh.end.ticks) - oldEnd, id);
        res2.push(clipSnap(findClip(s, id).clip));
      }
      return { clips: res2 };
    }
    if (act === "duplicate") {
      var l3 = requireClips(s, a.clips), placed = [];
      for (var j = 0; j < l3.length; j++) {
        var src = l3[j], sc = src.clip, sp = clipSpeed(sc), dur = tsec(sc.end) - tsec(sc.start);
        var to = has(a, "to") ? a.to + (tsec(sc.start) - tsec(l3[0].clip.start)) : tsec(sc.end) + (a.gap || 0);
        var spec2 = { item: String(sc.projectItem.nodeId), track: a.track || src.track, start: to, "in": r3(tsec(sc.inPoint) * sp), out: r3(tsec(sc.outPoint) * sp), media: src.video ? (a.include_linked === false ? "video" : "both") : "audio" };
        var pr = H.place_clips({ sequence: a.sequence, clips: [spec2] });
        if (pr.placed.length) {
          var nid = pr.placed[0].id;
          try { H.copy_effects({ sequence: a.sequence, from: String(sc.nodeId), to: [nid] }); } catch (eC) {}
          placed.push({ from: String(sc.nodeId), id: nid, start: pr.placed[0].start, end: pr.placed[0].end, duration: r3(dur) });
        } else placed.push({ from: String(sc.nodeId), error: pr.errors });
      }
      var okD = true; for (var w = 0; w < placed.length; w++) if (!placed[w].id) okD = false;
      return { duplicated: placed, verified: okD };
    }
    if (act === "lift_range" || act === "extract_range") {
      if (act === "extract_range") return H.ripple_delete_ranges({ sequence: a.sequence, ranges: [{ start: a.start, end: a.end }], tracks: a.tracks });
      // lift: cut at the edges, remove what is inside, no ripple
      var qs = qeSequenceFor(s), a0 = snapTicks(s, secToTicks(a.start)), a1 = snapTicks(s, secToTicks(a.end)), removed = 0;
      var tracks = [];
      if (a.tracks) { var tl = asArray(a.tracks); for (var t = 0; t < tl.length; t++) { var ref = parseTrackRef(tl[t]); tracks.push({ video: ref.video, index: ref.index, obj: getTrack(s, tl[t], false).track }); } }
      else { for (var v = 0; v < s.videoTracks.numTracks; v++) tracks.push({ video: true, index: v, obj: s.videoTracks[v] }); for (var au = 0; au < s.audioTracks.numTracks; au++) tracks.push({ video: false, index: au, obj: s.audioTracks[au] }); }
      for (var tk = 0; tk < tracks.length; tk++) {
        var tr = tracks[tk].obj, qt = tracks[tk].video ? qs.getVideoTrackAt(tracks[tk].index) : qs.getAudioTrackAt(tracks[tk].index);
        var eds = [a1, a0];
        for (var ed = 0; ed < eds.length; ed++) { for (var x = 0; x < tr.clips.numItems; x++) { var cs = parseFloat(tr.clips[x].start.ticks), ce = parseFloat(tr.clips[x].end.ticks); if (cs < eds[ed] - 1 && ce > eds[ed] + 1) { qt.razor(timecodeFor(s, eds[ed]), false, true); break; } } }
        var ins = [];
        for (var y = 0; y < tr.clips.numItems; y++) { var cc = tr.clips[y]; if (parseFloat(cc.start.ticks) >= a0 - 2 && parseFloat(cc.end.ticks) <= a1 + 2) ins.push(cc); }
        for (var z = ins.length - 1; z >= 0; z--) { ins[z].remove(false, true); removed++; }
      }
      return { lifted: removed, start: r3(ticksToSec(a0)), end: r3(ticksToSec(a1)) };
    }
    if (act === "split_edit") {
      // J/L cut: move only the audio edge of linked pairs. audio_lead > 0 starts the audio earlier (J); audio_tail > 0 ends it later (L).
      var l4 = requireClips(s, a.clips), res4 = [];
      for (var p4 = 0; p4 < l4.length; p4++) {
        var ve = l4[p4], auds = ve.video ? linkedEntries(s, ve.clip) : [ve];
        for (var q4 = 0; q4 < auds.length; q4++) {
          if (auds[q4].video) continue;
          var ac = auds[q4].clip, aid = String(ac.nodeId), sp4 = {};
          if (isNum(a.audio_lead) && a.audio_lead !== 0) sp4.trim_start = -a.audio_lead;
          if (isNum(a.audio_tail) && a.audio_tail !== 0) sp4.trim_end = -a.audio_tail;
          requireUnlocked([auds[q4]]);
          planTrim(s, ac, sp4)();
          res4.push({ audio: aid, video: String(ve.clip.nodeId), after: clipSnap(findClip(s, aid).clip) });
        }
      }
      if (!res4.length) fail("NO_AUDIO", "The selected clips have no linked audio to split.");
      return { split: res4 };
    }
    if (act === "freeze_frame") {
      // The frame at `at` held for `duration` s: cut at `at`, push the rest right, put a still there.
      var e5 = requireClips(s, a.clips)[0], cl5 = e5.clip, at = has(a, "at") ? a.at : tsec(cl5.start);
      if (!e5.video) fail("BAD_ARGS", "freeze_frame needs a video clip.");
      if (!a.still_path) fail("BAD_ARGS", "still_path is required (the server renders it).");
      var atT = snapTicks(s, secToTicks(at)), durT = snapTicks(s, secToTicks(a.duration || 2));
      var qs5 = qeSequenceFor(s);
      if (parseFloat(cl5.start.ticks) < atT - 1 && parseFloat(cl5.end.ticks) > atT + 1) qs5.getVideoTrackAt(parseTrackRef(e5.track).index).razor(timecodeFor(s, atT), true, true);
      var shiftTracks = a.ripple === false ? [] : [e5.trackObj];
      if (a.ripple !== false) { var lk5 = linkedEntries(s, cl5); for (var u = 0; u < lk5.length; u++) shiftTracks.push(lk5[u].trackObj); }
      for (var st5 = 0; st5 < shiftTracks.length; st5++) shiftFollowers(shiftTracks[st5], atT - 2, durT, "");
      var imp = H.import_files({ paths: [a.still_path], bin: "_MCP Plus/Freeze frames" });
      var pr5 = H.place_clips({ sequence: a.sequence, clips: [{ item: imp.imported[0].id, track: e5.track, start: ticksToSec(atT), duration: ticksToSec(durT), media: "video" }] });
      return { frozenAt: r3(ticksToSec(atT)), duration: r3(ticksToSec(durT)), still: pr5.placed[0] || null, errors: pr5.errors, verified: pr5.placed.length === 1 && Math.abs(pr5.placed[0].start - ticksToSec(atT)) < 0.02 };
    }
    fail("BAD_ARGS", "Unknown action " + act);
  };
  // Time interpolation / frame blending (QE) for speed-changed clips.
  H.time_interpolation = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    var modes = { frame_sampling: 0, frame_blending: 1, optical_flow: 2 };
    for (var i = 0; i < list.length; i++) {
      var e = list[i], qc = qeClipFor(s, e), d = { id: String(e.clip.nodeId) };
      if (a.interpolation) { if (modes[a.interpolation] === undefined) fail("BAD_ARGS", "interpolation: frame_sampling, frame_blending or optical_flow"); qc.setTimeInterpolationType(modes[a.interpolation]); d.interpolation = qeClipFor(s, e).timeInterpolationType; d.verified = d.interpolation === modes[a.interpolation]; }
      if (has(a, "frame_blend")) { qc.setFrameBlend(!!a.frame_blend); d.frameBlend = !!qeClipFor(s, e).frameBlend; }
      out.push(d);
    }
    var v = true; for (var k = 0; k < out.length; k++) if (out[k].verified === false) v = false;
    return { clips: out, verified: v };
  };
  // ---- source monitor
  H.source = function (a) {
    var act = a.action, sm = app.sourceMonitor;
    if (act === "open") { var it = resolveItem(a.item); if (has(a, "in") || has(a, "out")) { if (has(a, "in")) it.setInPoint(a["in"], 4); if (has(a, "out")) it.setOutPoint(a.out, 4); } sm.openProjectItem(it); var cur = sm.getProjectItem(); return { open: cur ? cur.name : null, verified: !!cur && String(cur.nodeId) === String(it.nodeId) }; }
    if (act === "close") { sm.closeAllClips(); return { closed: true }; }
    if (act === "state") { var pi = sm.getProjectItem(); var pos = null; try { pos = r3(tsec(sm.getPosition())); } catch (e) {} return { item: pi ? { id: String(pi.nodeId), name: pi.name, "in": r3(tsec(pi.getInPoint())), out: r3(tsec(pi.getOutPoint())) } : null, position: pos }; }
    if (act === "insert" || act === "overwrite") {
      var s = getSequence(a.sequence), item = a.item ? resolveItem(a.item) : sm.getProjectItem();
      if (!item) fail("BAD_ARGS", "No item: pass item or open one in the source monitor first.");
      if (has(a, "in")) item.setInPoint(a["in"], 4);
      if (has(a, "out")) item.setOutPoint(a.out, 4);
      var at = has(a, "time") ? a.time : tsec(s.getPlayerPosition());
      var vi = -1, ai = -1;
      if (a.video_track) vi = getTrack(s, a.video_track, true).index; else for (var v = 0; v < s.videoTracks.numTracks && vi < 0; v++) try { if (s.videoTracks[v].isTargeted()) vi = v; } catch (e1) {}
      if (a.audio_track) ai = getTrack(s, a.audio_track, true).index; else for (var u = 0; u < s.audioTracks.numTracks && ai < 0; u++) try { if (s.audioTracks[u].isTargeted()) ai = u; } catch (e2) {}
      if (vi < 0 && ai < 0) fail("NO_TARGET_TRACKS", "No targeted tracks.", "Target tracks with manage_tracks (target: true) or pass video_track / audio_track.");
      var tm = seqTime(s, at);
      if (act === "insert") s.insertClip(item, tm, vi < 0 ? 0 : vi, ai < 0 ? 0 : ai); else s.overwriteClip(item, tm, vi < 0 ? 0 : vi, ai < 0 ? 0 : ai);
      var placed = vi >= 0 ? findPlacedClip(s.videoTracks[vi], parseFloat(tm.ticks), null, 2) : findPlacedClip(s.audioTracks[ai], parseFloat(tm.ticks), null, 2);
      return { action: act, item: item.name, time: r3(tsec(tm)), clip: placed ? clipSnap(placed) : null, verified: !!placed };
    }
    if (act === "match_frame") {
      var s2 = getSequence(a.sequence), t = tsec(s2.getPlayerPosition()), hit = null;
      for (var vv = s2.videoTracks.numTracks - 1; vv >= 0 && !hit; vv--) { var tr = s2.videoTracks[vv]; for (var k = 0; k < tr.clips.numItems; k++) { var c = tr.clips[k]; if (tsec(c.start) <= t + 0.0005 && tsec(c.end) > t + 0.0005) { hit = { clip: c, track: "V" + (vv + 1) }; break; } } }
      if (!hit) fail("NO_CLIPS_MATCHED", "No video clip under the playhead.");
      var src = hit.clip.projectItem, mediaT = (tsec(hit.clip.inPoint) + (t - tsec(hit.clip.start))) * clipSpeed(hit.clip);
      sm.openProjectItem(src);
      return { item: src.name, itemId: String(src.nodeId), track: hit.track, sequenceTime: r3(t), mediaTime: r3(mediaT) };
    }
    fail("BAD_ARGS", "Unknown source action " + act);
  };


  // ---- 2.5 color, effects, keyframes
  // Lumetri Color parameter indices (Premiere 26.x; names repeat across sections, so by index).
  var LUMETRI = {
    temperature: 14, tint: 15, saturation: 16, exposure: 19, contrast: 20, highlights: 21, shadows: 22, whites: 23, blacks: 24,
    look_intensity: 38, faded_film: 40, sharpen: 41, vibrance: 42, creative_saturation: 43,
    vignette_amount: 110, vignette_midpoint: 111, vignette_roundness: 112, vignette_feather: 113
  };
  var LUMETRI_NAMES = { 14: "Temperature", 15: "Tint", 16: "Saturation", 19: "Exposure", 20: "Contrast", 21: "Highlights", 22: "Shadows", 23: "Whites", 24: "Blacks", 38: "Intensity", 40: "Faded Film", 41: "Sharpen", 42: "Vibrance", 43: "Saturation", 110: "Amount", 111: "Midpoint", 112: "Roundness", 113: "Feather" };
  function lumetriOn(s, entry, add) {
    var c = findComponent(entry.clip, "AE.ADBE Lumetri");
    if (!c && add) c = addEffect(s, entry, "video", resolveCatalogName("video", "Lumetri Color"), "AE.ADBE Lumetri");
    if (!c) fail("EFFECT_NOT_FOUND", "No Lumetri Color on '" + entry.clip.name + "'.");
    return c;
  }
  H.color_basic = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [], vals = a.values || {}, allOk = true;
    for (var k in vals) if (vals.hasOwnProperty(k) && LUMETRI[k] === undefined) fail("BAD_ARGS", "Unknown Lumetri control '" + k + "'.", "Use: " + (function () { var n = []; for (var x in LUMETRI) if (LUMETRI.hasOwnProperty(x)) n.push(x); return n.join(", "); })());
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e.video) continue;
      var comp = lumetriOn(s, e, true), set = {};
      for (var key in vals) {
        if (!vals.hasOwnProperty(key)) continue;
        var idx = LUMETRI[key], p = comp.properties[idx];
        if (!p) fail("PROPERTY_NOT_FOUND", "Lumetri control " + key + " (index " + idx + ") is missing on this Premiere version.");
        if (p.isTimeVarying()) p.setTimeVarying(false);
        p.setValue(vals[key], UPDATE_UI);
        var got = readValue(p);
        set[key] = got;
        if (typeof got === "number" && Math.abs(got - vals[key]) > 0.01) allOk = false;
      }
      out.push({ id: String(e.clip.nodeId), lumetri: comp.displayName, set: set });
    }
    if (!out.length) fail("NO_CLIPS_MATCHED", "No video clips in the selection.");
    return { clips: out, verified: allOk };
  };
  H.color_read = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].video) continue;
      var c = findComponent(list[i].clip, "AE.ADBE Lumetri"), d = { id: String(list[i].clip.nodeId), lumetri: !!c };
      if (c) { d.values = {}; for (var k in LUMETRI) if (LUMETRI.hasOwnProperty(k) && c.properties[LUMETRI[k]]) d.values[k] = readValue(c.properties[LUMETRI[k]]); }
      out.push(d);
    }
    return { clips: out };
  };
  H.stabilize = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), res = [];
    var vids = [];
    for (var i = 0; i < list.length; i++) if (list[i].video) vids.push(list[i]);
    if (!vids.length) fail("NO_CLIPS_MATCHED", "No video clips selected.");
    var r = applyEffectsTo(s, vids, [{ name: "Warp Stabilizer" }]);
    for (var k = 0; k < r.length; k++) res.push({ id: r[k].id, added: r[k].added });
    var done = false;
    try { done = !!s.isDoneAnalyzingForVideoEffects(); } catch (e) {}
    return { clips: res, analysisDone: done };
  };
  H.analysis_status = function (a) {
    var s = getSequence(a.sequence), done = false;
    try { done = !!s.isDoneAnalyzingForVideoEffects(); } catch (e) { fail("UNSUPPORTED_IN_PREMIERE", "This Premiere cannot report effect analysis status."); }
    var busy = 0;
    try { ensureQE(); busy = qe.project.numActiveProgressItems; } catch (e2) {}
    return { done: done, progressItems: busy };
  };
  // Adjustment layers cannot be created by script: reuse one from the project.
  H.adjustment_layer = function (a) {
    var s = getSequence(a.sequence), found = null;
    walk(requireProject().rootItem, "", function (it) { try { if (it.type !== 2 && it.isAdjustmentLayer && it.isAdjustmentLayer()) { found = it; return false; } } catch (e) {} });
    if (a.item) found = resolveItem(a.item);
    if (!found) fail("UNSUPPORTED_IN_PREMIERE", "Premiere's scripting API cannot create an Adjustment Layer.", "Create one once (Project panel > New Item > Adjustment Layer); this tool then finds and reuses it. Alternatively put the effects on the clips with apply_effects.");
    var spec = { item: String(found.nodeId), track: a.track || "V2", start: a.start || 0, duration: a.duration || 5, media: "video" };
    if (a.effects) spec.effects = a.effects;
    var r = H.place_clips({ sequence: a.sequence, clips: [spec], auto_create_tracks: true });
    if (a.preset_effects && r.placed.length) H.apply_effect_spec({ sequence: a.sequence, clips: [r.placed[0].id], effects: a.preset_effects });
    return { item: found.name, placed: r.placed, errors: r.errors, verified: r.placed.length === 1 };
  };
  H.keyframe_tools = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [], act = a.action;
    for (var i = 0; i < list.length; i++) {
      var e = list[i], c = e.clip, comp = requireComponent(c, a.effect || "Motion"), p = requireProp(comp, a.property), base = keyBase(c);
      var d = { id: String(c.nodeId), property: p.displayName };
      var keys = [];
      try { if (p.isTimeVarying()) { var kl = p.getKeys(); for (var k = 0; kl && k < kl.length; k++) keys.push(kl[k]); } } catch (e0) {}
      var inRange = function (t) { var cs = keyClipSeconds(base, t); return (!has(a, "from") || cs >= a.from - 0.0005) && (!has(a, "to") || cs <= a.to + 0.0005); };
      if (act === "list") {
        d.keys = [];
        for (var q = 0; q < keys.length; q++) { var v = null; try { v = p.getValueAtKey(keys[q]); } catch (e1) {} d.keys.push({ t: keyClipSeconds(base, keys[q]), v: v }); }
      } else if (act === "value_at") {
        var t = keyTime(base, a.time || 0), val = null;
        try { val = p.getValueAtTime(t); } catch (e2) { val = readValue(p); }
        d.time = a.time || 0; d.value = val;
      } else if (act === "interpolation") {
        if (INTERP[a.interp] === undefined) fail("BAD_ARGS", "interp: linear, hold, bezier, ease");
        var n = 0;
        for (var r = 0; r < keys.length; r++) if (inRange(keys[r])) { p.setInterpolationTypeAtKey(keys[r], INTERP[a.interp], UPDATE_UI); n++; }
        d.changed = n;
      } else if (act === "move" || act === "scale") {
        // Read values, remove the keys in range, add them back at the new times.
        var moved = [];
        for (var m = 0; m < keys.length; m++) if (inRange(keys[m])) moved.push({ t: keyClipSeconds(base, keys[m]), v: p.getValueAtKey(keys[m]) });
        for (var z = 0; z < keys.length; z++) if (inRange(keys[z])) p.removeKey(keys[z]);
        var pivot = has(a, "pivot") ? a.pivot : (has(a, "from") ? a.from : 0);
        for (var w = 0; w < moved.length; w++) {
          var nt = act === "move" ? moved[w].t + (a.delta || 0) : pivot + (moved[w].t - pivot) * (a.factor || 1);
          nt = Math.max(0, Math.min(base.dur, nt));
          var tt = keyTime(base, nt);
          p.addKey(tt); p.setValueAtKey(tt, moved[w].v, UPDATE_UI);
        }
        d.changed = moved.length;
        var after = [];
        try { var kk = p.getKeys(); for (var y = 0; kk && y < kk.length; y++) after.push(keyClipSeconds(base, kk[y])); } catch (e3) {}
        d.keysNow = after;
      } else fail("BAD_ARGS", "Unknown action " + act);
      out.push(d);
    }
    return { clips: out };
  };
  // Paste Attributes: pick what to copy from one clip to many.
  H.paste_attributes = function (a) {
    var s = getSequence(a.sequence), src = findClip(s, a.from);
    if (!src) fail("CLIP_NOT_FOUND", "Source clip not found: " + a.from);
    var what = a.attributes ? asArray(a.attributes) : ["motion", "opacity", "volume", "effects"], want = {};
    for (var w = 0; w < what.length; w++) want[what[w]] = 1;
    if (want.time_remapping) fail("UNSUPPORTED_IN_PREMIERE", "Time Remapping cannot be read or written by script on Premiere 26.x.", "Copy speed with set_clip_speed instead.");
    var targets = requireClips(s, a.to), out = [], sBase = keyBase(src.clip);
    for (var t = 0; t < targets.length; t++) {
      var dst = targets[t], copied = [];
      if (dst.video !== src.video || String(dst.clip.nodeId) === String(src.clip.nodeId)) continue;
      var dBase = keyBase(dst.clip);
      for (var k = 0; k < src.clip.components.numItems; k++) {
        var sc = src.clip.components[k], mn = String(sc.matchName), dc = null;
        var cat = mn === "AE.ADBE Motion" ? "motion" : (mn === "AE.ADBE Opacity" ? "opacity" : (/^Internal Volume/.test(mn) ? "volume" : (isBuiltIn(sc) ? "other" : "effects")));
        if (!want[cat]) continue;
        if (cat === "effects") {
          if (a.effects && !inList(asArray(a.effects), String(sc.displayName))) continue;
          dc = addEffect(s, dst, src.video ? "video" : "audio", resolveCatalogName(src.video ? "video" : "audio", sc.displayName), mn);
        } else dc = findComponent(dst.clip, mn);
        if (!dc) continue;
        copyComponentValues(sc, dc, sBase, dBase, a.keyframe_mode || "relative");
        copied.push(sc.displayName);
      }
      out.push({ id: String(dst.clip.nodeId), copied: copied });
    }
    return { clips: out, verified: out.length > 0 };
  };

  // ---- 2.6 audio
  H.audio_tools = function (a) {
    var s = getSequence(a.sequence), act = a.action, out = [];
    if (act === "solo_track") {
      var keep = {}, tl = asArray(a.tracks);
      for (var i = 0; i < tl.length; i++) keep[String(tl[i]).toUpperCase()] = 1;
      for (var t = 0; t < s.audioTracks.numTracks; t++) { var lab = "A" + (t + 1); s.audioTracks[t].setMute(keep[lab] ? 0 : 1); out.push({ track: lab, muted: !!s.audioTracks[t].isMuted() }); }
      return { tracks: out };
    }
    var list = audioTargets(s, requireClips(s, a.clips), a.include_linked);
    for (var j = 0; j < list.length; j++) {
      var e = list[j], c = e.clip, d = { id: String(c.nodeId), track: e.track };
      if (act === "mute" || act === "unmute") { c.disabled = act === "mute"; d.muted = !!c.disabled; d.verified = d.muted === (act === "mute"); }
      else if (act === "pan") {
        // Clip panner (Effect Controls > Panner): QE param "Pan" (mono) or "Balance" (stereo), -100..100, as a string.
        var qc = qeClipFor(s, e), pc = qc.getClipPanComponent();
        if (!pc) fail("UNSUPPORTED_IN_PREMIERE", "This clip has no panner (e.g. on a mono track).");
        var pl = pc.getParamList(), pname = pl && pl.length ? String(pl[0]) : "Pan";
        pc.setParamValue(pname, String(a.pan));
        d.pan = parseFloat(String(pc.getParamValue(pname)).replace(",", "."));
        d.param = pname;
        d.verified = Math.abs(d.pan - a.pan) < 0.5;
      } else if (act === "gain") {
        // Clip gain is read-only for scripts: the Amplify effect gives the same result.
        // Its Gain parameter is normalized: dB = 144 * value - 96 (-96..+48 dB).
        if (!(a.db >= -96 && a.db <= 48)) fail("BAD_ARGS", "gain db must be between -96 and 48.");
        var amp = findComponent(c, "Amplify");
        if (!amp) amp = addEffect(s, e, "audio", resolveCatalogName("audio", "Amplify"), null);
        if (!amp) fail("EFFECT_UNKNOWN", "Could not add Amplify.");
        var gp = null;
        for (var q = 0; q < amp.properties.numItems; q++) if (/^(gain|ganho)$/i.test(amp.properties[q].displayName)) gp = amp.properties[q];
        if (!gp) gp = amp.properties[3];
        if (gp.isTimeVarying()) gp.setTimeVarying(false);
        gp.setValue((a.db + 96) / 144, UPDATE_UI);
        var back = 144 * gp.getValue() - 96;
        d.gainDb = r3(back);
        d.verified = Math.abs(back - a.db) < 0.1;
      } else fail("BAD_ARGS", "Unknown audio action " + act);
      out.push(d);
    }
    var v = true; for (var z = 0; z < out.length; z++) if (out[z].verified === false) v = false;
    return { clips: out, verified: v };
  };
  // Source media ranges of clips (for loudness, beats, silence analysis on the server).
  H.clip_media = function (a) {
    var s = getSequence(a.sequence), list = requireClips(s, a.clips), out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i].clip, sp = clipSpeed(c), d = { id: String(c.nodeId), track: list[i].track, video: list[i].video, name: c.name, start: r3(tsec(c.start)), end: r3(tsec(c.end)), "in": r3(tsec(c.inPoint) * sp), out: r3(tsec(c.outPoint) * sp), speed: sp };
      try { d.media = itemMediaPath(c.projectItem); d.item = String(c.projectItem.nodeId); } catch (e) {}
      try { if (c.isSpeedReversed()) d.reversed = true; } catch (e2) {}
      try { d.disabled = !!c.disabled; } catch (e3) {}
      try { var vp = volumeProp(c); d.volumeDb = vp.isTimeVarying() ? null : levelToDb(vp.getValue()); } catch (e4) {}
      out.push(d);
    }
    return { clips: out, fps: r3(fps(s)), duration: r3(parseFloat(s.end) / TPS) };
  };

  // ---- 2.8 markers
  H.update_markers = function (a) {
    var ms = markerCollection(a), all = [], out = [];
    var m = ms.getFirstMarker();
    while (m) { all.push(m); m = ms.getNextMarker(m); }
    var re = a.name_regex ? new RegExp(a.name_regex, "i") : null;
    for (var i = 0; i < all.length; i++) {
      var mk = all[i], st = tsec(mk.start);
      if (a.guid && String(mk.guid) !== a.guid) continue;
      if (has(a, "time") && Math.abs(st - a.time) > 0.02) continue;
      if (re && !re.test(mk.name)) continue;
      var u = a.update || {};
      if (has(u, "name")) mk.name = u.name;
      if (has(u, "comment")) mk.comments = u.comment;
      if (has(u, "color")) try { mk.setColorByIndex(u.color); } catch (e) {}
      if (has(u, "duration")) mk.end = st + u.duration;
      if (has(u, "time")) { var dur = tsec(mk.end) - st; mk.start = u.time; mk.end = u.time + Math.max(0, dur); }
      if (u.type === "chapter") mk.setTypeAsChapter(); else if (u.type === "segmentation") mk.setTypeAsSegmentation(); else if (u.type === "comment") mk.setTypeAsComment(); else if (u.type === "web") mk.setTypeAsWebLink(u.url || "", "");
      out.push(markerInfo(mk));
    }
    if (!out.length) fail("MARKER_NOT_FOUND", "No marker matched.");
    return { updated: out, verified: true };
  };

  // ---- 2.10 navigation and playback
  H.navigate = function (a) {
    var s = getSequence(a.sequence), act = a.action, cur = tsec(s.getPlayerPosition()), target = null, eps = 0.5 / fps(s);
    if (act === "next_edit" || act === "prev_edit") {
      var pts = {}, tracks = a.tracks ? asArray(a.tracks) : null;
      eachClip(s, function (c, label) { if (tracks && !inList(tracks, label)) return; pts[r3(tsec(c.start))] = 1; pts[r3(tsec(c.end))] = 1; });
      var list = []; for (var k in pts) if (pts.hasOwnProperty(k)) list.push(parseFloat(k));
      list.sort(function (x, y) { return x - y; });
      for (var i = 0; i < list.length; i++) { if (act === "next_edit" && list[i] > cur + eps && target === null) target = list[i]; if (act === "prev_edit" && list[i] < cur - eps) target = list[i]; }
    } else if (act === "next_marker" || act === "prev_marker") {
      var m = s.markers.getFirstMarker();
      while (m) { var t = tsec(m.start); if (act === "next_marker" && t > cur + eps && target === null) target = t; if (act === "prev_marker" && t < cur - eps) target = t; m = s.markers.getNextMarker(m); }
    } else if (act === "clip") {
      var f = findClip(s, a.clip);
      if (!f) fail("CLIP_NOT_FOUND", "Clip not found: " + a.clip);
      target = tsec(a.edge === "end" ? f.clip.end : f.clip.start);
    } else if (act === "start") target = 0;
    else if (act === "end") target = parseFloat(s.end) / TPS;
    else if (act === "play" || act === "stop") {
      var qs = qeSequenceFor(s);
      if (act === "play") qs.player.play(a.speed || 1); else qs.player.stop();
      return { playing: act === "play" };
    } else fail("BAD_ARGS", "Unknown action " + act);
    if (target === null) return { moved: false, playhead: r3(cur), note: "Nothing found in that direction." };
    s.setPlayerPosition(String(secToTicks(target)));
    var now = tsec(s.getPlayerPosition());
    return { moved: true, playhead: r3(now), verified: Math.abs(now - target) < 0.02 };
  };
  H.workspace = function (a) {
    var list = app.getWorkspaces();
    if (!a.name) return { workspaces: list };
    var hit = null;
    for (var i = 0; i < list.length; i++) if (lower(list[i]) === lower(a.name)) hit = list[i];
    if (!hit) fail("BAD_ARGS", "Unknown workspace '" + a.name + "'.", "Available: " + list.join(", "));
    app.setWorkspace(hit);
    return { workspace: hit };
  };

  // ---- 2.9 export and delivery
  H.encode = function (a) {
    var enc = app.encoder, act = a.action;
    if (act === "launch") { enc.launchEncoder(); return { launched: true }; }
    if (act === "start") { enc.startBatch(); return { started: true }; }
    var range = { entire: enc.ENCODE_ENTIRE, in_out: enc.ENCODE_IN_TO_OUT, work_area: enc.ENCODE_WORKAREA }[a.range || "entire"];
    var out = new File(a.output), preset = new File(a.preset_path);
    if (!preset.exists) fail("FILE_NOT_FOUND", "Preset not found: " + a.preset_path);
    ensureParentFolder(out.fsName);
    enc.launchEncoder();
    var job = null;
    if (act === "item") job = enc.encodeProjectItem(resolveItem(a.item), out.fsName, preset.fsName, range, a.remove_on_done ? 1 : 0);
    else if (act === "sequence") job = enc.encodeSequence(getSequence(a.sequence), out.fsName, preset.fsName, range, a.remove_on_done ? 1 : 0);
    else if (act === "file") {
      var src = new File(a.file);
      if (!src.exists) fail("FILE_NOT_FOUND", "File not found: " + a.file);
      job = enc.encodeFile(src.fsName, out.fsName, preset.fsName, has(a, "in") ? a["in"] : 0, has(a, "out") ? a.out : 0, a.remove_on_done ? 1 : 0);
    } else fail("BAD_ARGS", "Unknown encode action " + act);
    if (a.start !== false) enc.startBatch();
    return { jobId: job ? String(job) : null, output: out.fsName, queued: !!job };
  };
  H.export_extra = function (a) {
    var s = getSequence(a.sequence), f = ensureParentFolder(a.path);
    if (a.format === "omf") {
      if (!(parseFloat(s.end) > 0)) fail("EMPTY_SEQUENCE", "Sequence '" + s.name + "' is empty.");
      var ok = null, err = null;
      // exportOMF can throw "Unknown error exception" and still write the file: judge by the file.
      try { ok = requireProject().exportOMF(s, f.fsName, a.title || s.name, a.sample_rate || 48000, a.bits || 16, a.encapsulate === false ? 0 : 1, 0, a.trim ? 1 : 0, a.handle_frames || 0, a.include_pan ? 1 : 0); } catch (eO) { err = String(eO); }
      var ex = new File(f.fsName).exists;
      if (!ex) fail("EXPORT_FAILED", "Premiere did not write " + f.fsName + (err ? " (" + err + ")" : "") + ".");
      return { path: f.fsName, ok: !!ok, exists: ex, verified: ex };
    }
    if (a.format === "project") {
      s.exportAsProject(f.fsName);
      return { path: f.fsName, exists: new File(f.fsName).exists, verified: new File(f.fsName).exists };
    }
    fail("BAD_ARGS", "Unknown format " + a.format);
  };

  // ---- undo / misc
  // Premiere has no undo groups, and ExtendScript DOM setters (TrackItem
  // start/end/inPoint/outPoint, move) never reach its undo stack. So every
  // mutating call is journaled: how many undo-stack steps it pushed (read with
  // qe.project.undoStackIndex) plus a snapshot of the clips it edits through
  // the DOM. undo({calls: N}) rewinds whole calls: Premiere undo for the
  // stack steps, then the DOM snapshot is put back.
  var JOURNAL = [], REDO = [], JOURNAL_MAX = 50;
  var READ_ONLY = {
    ping: 1, get_state: 1, project_info: 1, list_project_items: 1, get_item_info: 1, list_sequences: 1, get_sequence_settings: 1,
    get_playhead: 1, get_timeline: 1, get_selection: 1, find_clips: 1, list_available_effects: 1, get_clip_effects: 1,
    list_markers: 1, get_mogrt_params: 1, check_project: 1, inspect_media: 1, timeline_summary: 1, search_items: 1, inspect_state: 1, inspect_clip: 1, media_items: 1, color_read: 1, analysis_status: 1, clip_media: 1, workspace: 1, undo: 1, redo: 1, undo_history: 1, save_project: 1, scene_sources: 1, select_project: 1, close_other_projects: 1
  };
  // Handlers that change existing clips through DOM setters: snapshot their clips.
  var SNAPSHOT_FNS = { set_speed: 1, trim_clips: 1, move_clips: 1, set_clips: 1, close_gaps: 1, edit_qe: 1, edit_misc: 1 };
  function undoIndex() { try { ensureQE(); return Number(qe.project.undoStackIndex()); } catch (e) { return null; } }
  function projectKey() { try { return String(app.project.path); } catch (e) { return ""; } }
  function snapClip(c) {
    var d = { id: String(c.nodeId), s: c.start.ticks, e: c.end.ticks, i: c.inPoint.ticks, o: c.outPoint.ticks };
    try { d.dis = !!c.disabled; } catch (e1) {}
    try { d.n = c.name; } catch (e2) {}
    return d;
  }
  function takeSnapshot(fn, a) {
    if (!SNAPSHOT_FNS[fn]) return null;
    var s = null;
    try { s = getSequence(a.sequence); } catch (e) { return null; }
    var list = [], seen = {};
    function add(c) { var id = String(c.nodeId); if (seen[id]) return; seen[id] = 1; list.push(snapClip(c)); }
    if (fn === "close_gaps") {
      var tracks = asArray(a.tracks || a.track);
      for (var t = 0; t < tracks.length; t++) { try { var tr = getTrack(s, tracks[t], false).track; for (var i = 0; i < tr.clips.numItems; i++) add(tr.clips[i]); } catch (e2) {} }
    } else {
      var sel = [];
      try { sel = selectClips(s, a.clips); } catch (e3) {}
      for (var k = 0; k < sel.length; k++) {
        add(sel[k].clip);
        try { var l = sel[k].clip.getLinkedItems(); if (l) for (var m = 0; m < l.numItems; m++) add(l[m]); } catch (e4) {}
      }
    }
    return { seq: String(s.sequenceID), clips: list };
  }
  function restoreSnapshot(snap) {
    if (!snap) return 0;
    var s = null, n = 0;
    try { s = getSequence(snap.seq); } catch (e) { return 0; }
    for (var i = 0; i < snap.clips.length; i++) {
      var d = snap.clips[i], f = findClip(s, d.id);
      if (!f) continue;
      var c = f.clip, curStart = parseFloat(c.start.ticks);
      // Widen before narrowing so the edges never cross.
      if (parseFloat(d.s) < curStart) { c.start = timeFromTicks(d.s); c.end = timeFromTicks(d.e); } else { c.end = timeFromTicks(d.e); c.start = timeFromTicks(d.s); }
      c.inPoint = timeFromTicks(d.i);
      c.outPoint = timeFromTicks(d.o);
      if (d.dis !== undefined) try { c.disabled = d.dis; } catch (e1) {}
      if (d.n !== undefined && c.name !== d.n) try { c.name = d.n; } catch (e2) {}
      n++;
    }
    return n;
  }
  function journalCall(fn, a, before, snap) {
    var after = undoIndex();
    var steps = before !== null && after !== null ? after - before : 0;
    if (steps < 0) steps = 0;
    if (!steps && !(snap && snap.clips.length)) return;
    // State of the same clips after the call, for redo.
    var afterSnap = null;
    if (snap && snap.clips.length) {
      afterSnap = { seq: snap.seq, clips: [] };
      try { var sq = getSequence(snap.seq); for (var i = 0; i < snap.clips.length; i++) { var f = findClip(sq, snap.clips[i].id); if (f) afterSnap.clips.push(snapClip(f.clip)); } } catch (e) {}
    }
    JOURNAL.push({ fn: fn, steps: steps, after: after, snap: snap, afterSnap: afterSnap, project: projectKey() });
    if (JOURNAL.length > JOURNAL_MAX) JOURNAL.shift();
    REDO = []; // a new edit ends the redo history, as in Premiere
  }
  H.undo = function (a) {
    ensureQE();
    if (has(a, "calls")) {
      var want = a.calls, done = [], steps = 0, restored = 0;
      while (done.length < want && JOURNAL.length) {
        var last = JOURNAL[JOURNAL.length - 1];
        if (last.project !== projectKey()) { JOURNAL = []; break; }
        var idx = undoIndex();
        if (last.steps && idx !== last.after) fail("UNDO_STACK_CHANGED", "Premiere's undo history changed since '" + last.fn + "' ran (edits made by hand?). Nothing was undone.", "Use undo with steps instead.");
        for (var i = 0; i < last.steps; i++) qe.project.undo();
        steps += last.steps;
        restored += restoreSnapshot(last.snap);
        JOURNAL.pop();
        REDO.push(last);
        done.push(last.fn);
      }
      var res = { undoneCalls: done, premiereSteps: steps, restoredClips: restored };
      if (done.length < want) res.warning = "Only " + done.length + " recorded call(s) could be undone.";
      return res;
    }
    var n = a.steps || 1;
    for (var k = 0; k < n; k++) qe.project.undo();
    JOURNAL = []; REDO = []; // raw steps no longer line up with recorded calls
    return { undone: n };
  };
  H.redo = function (a) {
    ensureQE();
    if (has(a, "calls")) {
      var want = a.calls, done = [], steps = 0, restored = 0;
      while (done.length < want && REDO.length) {
        var e = REDO[REDO.length - 1];
        if (e.project !== projectKey()) { REDO = []; break; }
        var idx = undoIndex();
        if (e.steps && idx !== e.after - e.steps) fail("UNDO_STACK_CHANGED", "Premiere's undo history changed since '" + e.fn + "' was undone. Nothing was redone.", "Use redo with steps instead.");
        for (var i = 0; i < e.steps; i++) qe.project.redo();
        steps += e.steps;
        restored += restoreSnapshot(e.afterSnap);
        REDO.pop();
        JOURNAL.push(e);
        done.push(e.fn);
      }
      var res = { redoneCalls: done, premiereSteps: steps, restoredClips: restored };
      if (done.length < want) res.warning = "Only " + done.length + " undone call(s) could be redone.";
      return res;
    }
    var n = a.steps || 1;
    for (var k = 0; k < n; k++) qe.project.redo();
    JOURNAL = []; REDO = [];
    return { redone: n };
  };
  H.undo_history = function () {
    var out = [];
    for (var i = JOURNAL.length - 1; i >= 0; i--) out.push({ fn: JOURNAL[i].fn, premiereSteps: JOURNAL[i].steps, snapshotClips: JOURNAL[i].snap ? JOURNAL[i].snap.clips.length : 0 });
    return { calls: out };
  };
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

  // Calls whose job is to change the active sequence (or project); every other
  // call puts the sequence that was active back when it ends, so a tool that
  // works on another sequence (export_frames with sequence: "Vert"...) never
  // leaves later calls without a sequence argument pointing at it.
  var SWITCHES_PROJECT = { new_project: 1, open_project: 1, close_project: 1, select_project: 1, close_other_projects: 1, batch: 1, eval_script: 1 };
  var KEEPS_ACTIVE = { open_sequence: 1, create_sequence: 1, new_project: 1, open_project: 1, close_project: 1, delete_sequence: 1, save_project_as: 1, eval_script: 1, duplicate_sequence: 1, auto_reframe: 1, create_subsequence: 1, ping: 1, get_state: 1, select_project: 1, close_other_projects: 1, check_project: 1, import_special: 1 };
  function restoreActive(orig) {
    try {
      // Closing every sequence tab of a project (fast batches) can make
      // Premiere switch app.project to another open project: switch back.
      if (projectKey() !== orig.project && orig.project) {
        try { app.openDocument(orig.project, true, true, true, true); } catch (eP) {}
        if (projectKey() !== orig.project) return;
      }
      if (!orig.id) return;
      var cur = app.project.activeSequence;
      if (cur && String(cur.sequenceID) === orig.id) return;
      var seqs = allSequences();
      for (var i = 0; i < seqs.length; i++) if (String(seqs[i].sequenceID) === orig.id) { _qsCache = null; app.project.openSequence(orig.id); return; }
    } catch (e) {}
  }
  // ================================================================ dispatcher
  $.__mcpPlus = {
    version: LIB_VERSION,
    handlers: H,
    call: function (fn, argsJson) {
      var started = new Date().getTime(), journaled = false, before = null, snap = null, args = {};
      try {
        if (!H[fn]) return stringify({ ok: false, error: { code: "UNKNOWN_FUNCTION", message: "Unknown host function: " + fn } });
        args = parse(argsJson) || {};
        _qsCache = null; _qeFxCache = {}; UPDATE_UI = true; // per-call state
        _pinnedProject = null;
        if (!SWITCHES_PROJECT[fn]) _pinnedProject = stableProject();
        journaled = !READ_ONLY[fn] && fn.indexOf("export") !== 0 && !!app.project;
        if (journaled) { before = undoIndex(); try { snap = takeSnapshot(fn, args); } catch (eS) {} }
        var origSeq = null;
        var keep = KEEPS_ACTIVE[fn];
        if (fn === "batch") { var bops = asArray(args.ops); for (var bi = 0; bi < bops.length; bi++) if (bops[bi] && KEEPS_ACTIVE[bops[bi].fn]) keep = 1; }
        if (!keep) { try { if (app.project && app.project.rootItem) origSeq = { id: app.project.activeSequence ? String(app.project.activeSequence.sequenceID) : null, project: projectKey() }; } catch (eA) {} }
        var data;
        try { data = H[fn](args); }
        finally { if (origSeq) restoreActive(origSeq); }
        if (!READ_ONLY[fn]) MUTATIONS++;
        if (journaled) try { journalCall(fn, args, before, snap); } catch (eJ) {}
        var np = 0; try { np = app.projects.numProjects; } catch (eN) {}
        return stringify({ ok: true, data: data, ms: new Date().getTime() - started, np: np });
      } catch (e) {
        if (!READ_ONLY[fn]) MUTATIONS++;
        // A failed call can still have pushed undo steps; record them so the
        // next undo({calls}) stays aligned with Premiere's stack.
        if (journaled) try { journalCall(fn, args, before, snap); } catch (eJ2) {}
        var err = e instanceof Fail ? { code: e.code, message: e.message, hint: e.hint } : { code: "HOST_ERROR", message: (e && e.message) ? e.message : String(e), line: e && e.line };
        return stringify({ ok: false, error: err, ms: new Date().getTime() - started });
      }
    }
  };
  return "loaded " + LIB_VERSION;
}());
