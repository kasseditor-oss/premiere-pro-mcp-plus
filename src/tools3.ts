import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import sharp from "sharp";
import { BridgeError } from "./bridge.js";
import * as an from "./analysis.js";
import * as ae from "./autoedit.js";
import * as media from "./media.js";
import { confirmationsOn, consumeToken, issueToken } from "./policy.js";

/**
 * Phase 3: automatic edits that really execute (not plans). Every action takes
 * preview: true (returns what it would do, edits nothing) and checkpoint: true
 * (clones the sequence first).
 */
export function registerPhase3(ctx: any) {
  const { tool, call, ANN, seqArg, clipSelector, track, bridge, ensureOutputDir, registry, server } = ctx;
  const run = (name: string, args: any) => registry.get(name).handler(args);
  const sources = async (sequence: string | undefined, clips: any) => ((await call("clip_media", { sequence, clips })) as any).clips as any[];
  const toSeq = (c: any, t: number) => ae.r3(c.start + (t - c.in) / (c.speed || 1));

  /** Speech regions (sequence time) of audio clips. */
  async function speech(sequence: string | undefined, sel: any, noiseDb?: number, join = 0.15) {
    const clips = (await sources(sequence, sel)).filter((c) => !c.video && c.media && !c.disabled);
    if (!clips.length) throw new BridgeError("NO_AUDIO", "No audio clips with media matched the voice selector.", "Pass voice: {tracks:['A1']} or clip ids.");
    const out: { clip: any; active: ae.Range[]; threshold: number; reliable: boolean; floor?: number; peak?: number }[] = [];
    for (const c of clips) {
      const env = await an.envelope(c.media, 0.02, c.in, c.out - c.in);
      const at: any = an.autoThreshold(env);
      const th = noiseDb ?? at.threshold;
      const act = an.activeRegions(env, th, join, 0.06).map((r) => ({ start: toSeq(c, c.in + r.start), end: toSeq(c, c.in + r.end) }));
      out.push({ clip: c, active: act, threshold: th, reliable: noiseDb !== undefined || at.reliable !== false, floor: at.floor, peak: at.peak });
    }
    return out;
  }
  /** Seconds of the sequence spanned by these clips (for the "how much does this cut" check). */
  const spanOf = (clips: any[]) => {
    const r = ae.mergeRanges(clips.map((c) => ({ start: c.start, end: c.end })));
    return r.reduce((n, x) => n + x.end - x.start, 0);
  };
  /** Transcript words in sequence time: from an id/file, or transcribe the voice clips now. */
  async function transcriptFor(a: any) {
    if (a.transcript) return ctx.loadTranscript(a.transcript);
    const r: any = await run("transcribe", { sequence: a.sequence, clips: a.voice ?? { kind: "audio", tracks: ["A1"] }, language: a.language, model: a.model });
    return JSON.parse(fs.readFileSync(r.path, "utf-8"));
  }
  /**
   * Ripple-delete the ranges. Cuts that remove more than max_cut (default 40%) of
   * the material need a confirmation token (or a preview first): a wrong
   * threshold must never wipe a sequence silently.
   */
  async function cut(a: any, ranges: (ae.Range & { reason?: string; text?: string })[], extra: any, span?: number) {
    const merged = ae.mergeRanges(ranges, 0.02);
    const total = ae.r3(merged.reduce((n, r) => n + (r.end - r.start), 0));
    const detail = ranges.length && ranges.some((r) => r.reason) ? [...ranges].sort((x, y) => x.start - y.start).map((r) => ({ start: ae.r3(r.start), end: ae.r3(r.end), reason: r.reason, text: r.text })) : undefined;
    const share = span && span > 0 ? ae.r3(total / span) : undefined;
    if (a.preview || !merged.length) return { preview: !!a.preview, ranges: merged, count: merged.length, seconds: total, share, detail, ...extra };
    const limit = a.max_cut ?? 0.4;
    if (share !== undefined && share > limit && confirmationsOn()) {
      if (a.confirm_token) consumeToken("auto_edit", a);
      else
        return {
          status: "needs_confirmation",
          preview: { ranges: merged, count: merged.length, seconds: total, share, detail, ...extra },
          confirm_token: issueToken("auto_edit", a),
          hint: `This removes ${Math.round(share * 100)}% of the material (limit ${Math.round(limit * 100)}%). Check the ranges; repeat the same call with confirm_token to apply, or change the thresholds.`,
        };
    }
    const before: any = await call("get_sequence_settings", { sequence: a.sequence });
    const r: any = await call("ripple_delete_ranges", { sequence: a.sequence, ranges: merged, tracks: a.tracks }, 900000);
    const after: any = await call("get_sequence_settings", { sequence: a.sequence });
    return { ranges: merged, count: merged.length, seconds: total, durationBefore: before.duration, durationAfter: after.duration, verified: Math.abs(before.duration - after.duration - r.removedSeconds) < 0.1 && r.removedSeconds > 0, ...extra };
  }

  tool(
    "auto_edit",
    "Automatic edits",
    "Edits that run end to end (preview: true shows the plan without editing; checkpoint: true clones the sequence first). jump_cut: remove silences of the voice with padding and ripple on all tracks, optional alternating punch-in (zoom 100<->106). remove_fillers: remove filler words (per-language list, configurable), shorten quiet pauses, drop repeated takes (keeps the last). Both return detail (each range with its reason) and ask for confirmation above max_cut. beat_montage: place items cut on the music's beats (every N beats). emphasis_zoom: punch-in keyframes at keywords (transcript) or loudness peaks. multicam: switch between angle tracks to whoever is speaking (audio energy, minimum shot length). speaker_reframe: keep the speaker centered in a vertical sequence (by speaker audio, or by frame analysis), smooth keyframes. shorts: rank the best windows of a long clip and build a 9:16 sequence per window with reframe, styled captions and a CTA (optional export). chapters: chapter markers + YouTube text from the transcript or markers. mix: voice to -16 LUFS, music ducked under the voice, mix to -14 LUFS / -1 dBTP verified on an export. sync_audio: line up an external recording with the camera audio by correlation and place it. visual_qa: list problems with timecodes (black frames, flashes, offline, disabled, gaps, audio clipping, captions outside the safe zone) + contact sheet. paper_edit: build a sequence from script lines matched to the transcript, in script order.",
    {
      action: z.enum(["jump_cut", "remove_fillers", "beat_montage", "emphasis_zoom", "multicam", "speaker_reframe", "shorts", "chapters", "mix", "sync_audio", "visual_qa", "paper_edit"]),
      sequence: seqArg,
      preview: z.boolean().optional(),
      voice: clipSelector.optional().describe("Voice clips (default audio on A1)"),
      music: clipSelector.optional().describe("Music clips (beat_montage, mix; default A2)"),
      clips: clipSelector.optional().describe("Video clips to act on (zoom, reframe, shorts source, multicam angles)"),
      tracks: z.array(z.string()).optional().describe("jump_cut / remove_fillers: tracks to ripple (default all, keeps sync)"),
      // jump_cut
      min_silence: z.number().optional().describe("Shortest silence removed (s), default 0.5"),
      padding: z.number().optional().describe("Kept around speech (s), default 0.12"),
      noise_db: z.number().optional().describe("Silence threshold dBFS (default: measured noise floor + margin)"),
      zoom: z.number().optional().describe("jump_cut / emphasis_zoom: punch-in scale %, e.g. 106 (jump_cut alternates 100/zoom)"),
      zoom_track: track.optional().describe("Video track to zoom (default V1)"),
      // fillers
      transcript: z.string().optional().describe("Transcript id (tr_...) or JSON path; default: transcribe the voice now"),
      language: z.string().optional(),
      model: z.enum(["tiny", "base", "small", "medium", "large-v3"]).optional(),
      fillers: z.array(z.string()).optional().describe("Override the filler list (default: the language's list; accents count, 'é' is not 'e')"),
      max_pause: z.number().optional().describe("remove_fillers: pauses longer than this are shortened (s), default 0.8"),
      keep_pause: z.number().optional().describe("remove_fillers: pause kept (s), default 0.25"),
      repeated: z.boolean().optional().describe("remove_fillers: drop repeated takes (default true)"),
      max_gap: z.number().optional().describe("remove_fillers: gaps longer than this are never cut (s), default 3"),
      max_cut: z.number().optional().describe("jump_cut / remove_fillers: share of the material that can go without confirmation, default 0.4"),
      confirm_token: z.string().optional().describe("Token from a needs_confirmation answer (single use)"),
      // beat montage
      items: z.array(z.string()).optional().describe("beat_montage: project items to place (cycled)"),
      every: z.number().int().optional().describe("beat_montage: beats per clip, default 2"),
      track: track.optional(),
      transition: z.string().optional().describe("beat_montage: transition name between clips"),
      count: z.number().int().optional(),
      // emphasis
      keywords: z.array(z.string()).optional(),
      hold: z.number().optional().describe("emphasis_zoom: seconds the punch-in holds, default 0.6"),
      // multicam
      angles: z.array(z.object({ video: z.string().describe("Video track, e.g. V1"), audio: clipSelector.describe("That angle's speaker audio") })).optional(),
      min_shot: z.number().optional().describe("multicam: minimum shot length (s), default 2"),
      // reframe
      method: z.enum(["audio", "frames"]).optional(),
      speakers: z.array(z.object({ x: z.number().describe("Speaker x in the source frame (px)"), audio: clipSelector })).optional(),
      // shorts
      length: z.number().optional().describe("shorts: seconds per short, default 45"),
      cta: z.string().optional().describe("shorts: call-to-action text for the last 2 s"),
      export: z.boolean().optional(),
      folder: z.string().optional(),
      // chapters
      from: z.enum(["transcript", "markers"]).optional(),
      min_length: z.number().optional().describe("chapters: shortest chapter (s), default 10"),
      // mix
      voice_lufs: z.number().optional(),
      target_lufs: z.number().optional(),
      true_peak: z.number().optional(),
      duck_db: z.number().optional(),
      // sync
      file: z.string().optional().describe("sync_audio: external recording"),
      // visual_qa
      captions_source: z.string().optional(),
      platform: z.enum(["youtube", "shorts", "reels", "tiktok", "instagram_feed"]).optional(),
      // paper edit
      script: z.array(z.string()).optional().describe("paper_edit: lines in the order wanted"),
      item: z.string().optional().describe("paper_edit: project item of the recording the transcript belongs to"),
      name: z.string().optional(),
    },
    ANN.destructive,
    async (a: any, jctx: any) => {
      const prog = (p: number, n?: string) => jctx?.progress?.(p, n);
      switch (a.action) {
        // ------------------------------------------------------------ 1 jump cut
        case "jump_cut": {
          const sp = await speech(a.sequence, a.voice ?? { kind: "audio", tracks: ["A1"] }, a.noise_db, Math.min(0.3, (a.min_silence ?? 0.5) / 2));
          const ranges: ae.Range[] = [];
          for (const s of sp) ranges.push(...ae.silencesBetween(s.active, s.clip.start, s.clip.end, a.min_silence ?? 0.5, a.padding ?? 0.12));
          // Only cut where every voice track is silent.
          const silentEverywhere = ranges.filter((r) => sp.every((s) => !s.active.some((x) => x.start < r.end - 0.01 && x.end > r.start + 0.01)));
          const noisy = sp.filter((s) => !s.reliable);
          const extra: any = { thresholds: sp.map((s) => s.threshold) };
          if (noisy.length)
            extra.warning = `No clear silence in ${noisy.length} voice clip(s): noise floor ${noisy[0].floor} dBFS vs peaks ${noisy[0].peak} dBFS (constant noise, music or compressed audio). Nothing was cut there. Pass noise_db (e.g. ${ae.r3((noisy[0].floor ?? -40) + 3)}) to force a threshold.`;
          const res: any = await cut(a, silentEverywhere.map((r) => ({ ...r, reason: "silence" })), extra, spanOf(sp.map((s) => s.clip)));
          if (!a.preview && a.zoom && res.count) {
            const vt = a.zoom_track || "V1";
            const vs: any = await call("find_clips", { sequence: a.sequence, clips: { tracks: [vt] } });
            const ids = vs.clips.sort((x: any, y: any) => x.start - y.start).filter((_: any, i: number) => i % 2 === 1).map((c: any) => c.id);
            if (ids.length) await call("set_transform", { sequence: a.sequence, clips: ids, scale: a.zoom });
            res.zoomed = ids.length;
          }
          return res;
        }
        // ------------------------------------------------------------ 2 fillers / pauses / repeated takes
        case "remove_fillers": {
          const tr = await transcriptFor(a);
          const lang = String(a.language || tr.language || "").slice(0, 2).toLowerCase();
          const list = a.fillers?.length ? a.fillers : ae.fillersFor(lang);
          const fill = ae.fillerRanges(tr.words, list, a.fillers?.length ? [] : undefined).map((r) => ({ ...r, start: r.start - 0.03, end: r.end + 0.03 }));
          // Pauses: only gaps where the voice is really quiet. A long gap between
          // transcribed words is often speech Whisper skipped (overlap, noise).
          const maxGap = a.max_gap ?? 3;
          let pauses: (ae.Range & { reason: string })[] = ae.longPauses(tr.words, a.max_pause ?? 0.8, a.keep_pause ?? 0.25).map((p) => ({ ...p, reason: "pause" }));
          const skipped: ae.Range[] = pauses.filter((p) => p.end - p.start > maxGap);
          pauses = pauses.filter((p) => p.end - p.start <= maxGap);
          let audioChecked = false;
          if (!a.transcript || a.voice) {
            try {
              const sp = await speech(a.sequence, a.voice ?? { kind: "audio", tracks: ["A1"] });
              const loud = (p: ae.Range) => sp.some((s) => !s.reliable && s.clip.start < p.end && s.clip.end > p.start) || sp.some((s) => s.active.some((x) => Math.min(x.end, p.end) - Math.max(x.start, p.start) > 0.15));
              skipped.push(...pauses.filter(loud));
              pauses = pauses.filter((p) => !loud(p));
              audioChecked = true;
            } catch {
              /* no voice clips: transcript only */
            }
          }
          const takes = a.repeated === false ? [] : ae.repeatedTakes(tr.segments);
          const all = [
            ...fill.map((f) => ({ start: f.start, end: f.end, reason: "filler", text: f.word })),
            ...pauses,
            ...takes.map((t) => ({ start: t.start, end: t.end, reason: "repeated_take", text: t.text })),
          ];
          const span = tr.words.length ? Math.max(...tr.words.map((w: any) => w.end)) - Math.min(...tr.words.map((w: any) => w.start)) : undefined;
          const res: any = await cut(a, all, { language: lang || undefined, fillers: fill.map((f) => ({ word: f.word, at: ae.r3(f.start) })), pauses: pauses.length, repeatedTakes: takes.map((t) => ({ text: t.text, at: t.start, keptAt: t.keptAt })), pausesNotCut: skipped.length ? skipped.map((p) => ({ start: ae.r3(p.start), end: ae.r3(p.end) })) : undefined, audioChecked }, span);
          if (skipped.length) res.warning = `${skipped.length} gap(s) between words were not cut: longer than ${maxGap}s or with sound in them (probably speech the transcript missed).`;
          if (!a.transcript) res.note = "Transcript times are sequence times of the voice clips at the moment of the call.";
          return res;
        }
        // ------------------------------------------------------------ 3 beat montage
        case "beat_montage": {
          if (!a.items?.length) throw new BridgeError("BAD_ARGS", "items (project items to place) are required.");
          const m = (await sources(a.sequence, a.music ?? { kind: "audio", tracks: ["A2"] })).find((c) => !c.video && c.media);
          if (!m) throw new BridgeError("NO_AUDIO", "No music clip found.", "Pass music: a selector of the music clip.");
          const b = await an.beats(m.media, m.in, m.out - m.in);
          const beatsSeq = b.beats.map((t) => toSeq(m, t)).filter((t) => t >= m.start - 0.01 && t <= m.end + 0.01);
          const every = a.every ?? 2;
          const marks = beatsSeq.filter((_, i) => i % every === 0);
          const clips: any[] = [];
          for (let i = 0; i + 1 < marks.length && (!a.count || clips.length < a.count); i++) clips.push({ item: a.items[i % a.items.length], track: a.track || "V1", start: marks[i], duration: ae.r3(marks[i + 1] - marks[i]), media: "video" });
          if (a.preview) return { preview: true, bpm: b.bpm, beats: beatsSeq.length, clips };
          const r: any = await call("place_clips", { sequence: a.sequence, clips }, 120000 + clips.length * 3000);
          if (a.transition && r.placed.length) await call("add_transitions", { sequence: a.sequence, clips: r.placed.slice(1).map((p: any) => p.id), name: a.transition, position: "start", duration: Math.min(0.3, (b.period || 0.5) / 2) }, 120000);
          const aligned = r.placed.every((p: any, i: number) => Math.abs(p.start - clips[i].start) < 0.04);
          return { bpm: b.bpm, placed: r.placed.length, errors: r.errors, firstBeats: marks.slice(0, 8), verified: aligned && r.placed.length === clips.length };
        }
        // ------------------------------------------------------------ 4 emphasis zoom
        case "emphasis_zoom": {
          let times: number[] = [];
          if (a.keywords?.length) {
            const tr = await transcriptFor(a);
            const kw = a.keywords.map(ae.norm);
            times = tr.words.filter((w: any) => kw.includes(ae.norm(w.word))).map((w: any) => w.start);
          } else {
            const sp = await speech(a.sequence, a.voice ?? { kind: "audio", tracks: ["A1"] });
            for (const s of sp) {
              const env = await an.envelope(s.clip.media, 0.05, s.clip.in, s.clip.out - s.clip.in);
              const sorted = [...env.db].sort((x, y) => y - x);
              const lim = sorted[Math.floor(sorted.length * 0.03)] ?? 0;
              let last = -9;
              env.db.forEach((v, i) => {
                const t = toSeq(s.clip, s.clip.in + i * env.hop);
                if (v >= lim && t - last > 3) {
                  times.push(t);
                  last = t;
                }
              });
            }
          }
          times = times.slice(0, a.count || 30);
          const zoom = a.zoom ?? 115;
          const hold = a.hold ?? 0.6;
          const vt = a.zoom_track || "V1";
          const plan: any[] = [];
          for (const t of times) {
            const f: any = await call("find_clips", { sequence: a.sequence, clips: { tracks: [vt], at: t } });
            const c = f.clips[0];
            if (!c) continue;
            plan.push({ id: c.id, at: ae.r3(t), keys: [{ t: Math.max(c.start, t - 0.12), v: 100 }, { t: t, v: zoom, interp: "ease" }, { t: Math.min(c.end, t + hold), v: zoom }, { t: Math.min(c.end, t + hold + 0.2), v: 100, interp: "ease" }] });
          }
          if (a.preview) return { preview: true, points: plan.map((p) => ({ clip: p.id, at: p.at })) };
          let keys = 0;
          for (const p of plan) {
            const r: any = await call("add_keyframes", { sequence: a.sequence, clips: p.id, animations: [{ property: "Scale", time_base: "sequence", keys: p.keys.map((k: any) => ({ ...k, t: ae.r3(k.t) })) }] });
            keys += r.results.reduce((n: number, x: any) => n + x.keys, 0);
          }
          return { points: plan.length, keys, at: plan.map((p) => p.at), verified: keys >= plan.length * 3 };
        }
        // ------------------------------------------------------------ 5 multicam
        case "multicam": {
          const angles = a.angles ?? [{ video: "V1", audio: { tracks: ["A1"] } }, { video: "V2", audio: { tracks: ["A2"] } }];
          const hop = 0.1;
          const envs: number[][] = [];
          let t0 = Infinity;
          let t1 = -Infinity;
          const auds: any[] = [];
          for (const g of angles) {
            const c = (await sources(a.sequence, g.audio)).find((x) => !x.video && x.media);
            if (!c) throw new BridgeError("NO_AUDIO", `No audio for angle ${g.video}.`);
            auds.push(c);
            t0 = Math.min(t0, c.start);
            t1 = Math.max(t1, c.end);
          }
          for (const c of auds) {
            const env = await an.envelope(c.media, hop, c.in, c.out - c.in);
            const row: number[] = [];
            for (let t = t0; t < t1; t += hop) {
              const i = Math.floor(((t - c.start) * (c.speed || 1)) / hop);
              row.push(i >= 0 && i < env.db.length ? env.db[i] : -120);
            }
            envs.push(row);
          }
          const shots = ae.chooseAngles(envs, hop, a.min_shot ?? 2).map((s) => ({ ...s, start: ae.r3(s.start + t0), end: ae.r3(s.end + t0), video: angles[s.angle].video }));
          if (a.preview) return { preview: true, shots };
          const cuts = shots.slice(1).map((s) => s.start);
          if (cuts.length) await call("razor", { sequence: a.sequence, times: cuts, tracks: angles.map((g: any) => g.video), include_linked: false });
          // Enable the chosen angle in each shot, disable the others.
          for (const s of shots) {
            const mid = (s.start + s.end) / 2;
            for (const g of angles) {
              const f: any = await call("find_clips", { sequence: a.sequence, clips: { tracks: [g.video], at: mid } });
              if (f.clips[0]) await call("set_clips", { sequence: a.sequence, clips: f.clips[0].id, enabled: g.video === s.video });
            }
          }
          let ok = true;
          for (const s of shots) {
            const mid = (s.start + s.end) / 2;
            for (const g of angles) {
              const f: any = await call("find_clips", { sequence: a.sequence, clips: { tracks: [g.video], at: mid } });
              if (f.clips[0] && !!f.clips[0].disabled === (g.video === s.video)) ok = false;
            }
          }
          return { shots, switches: cuts.length, verified: ok };
        }
        // ------------------------------------------------------------ 6 speaker reframe
        case "speaker_reframe": {
          const st: any = await call("get_sequence_settings", { sequence: a.sequence });
          const W = st.width;
          const H = st.height;
          const c = (await sources(a.sequence, a.clips ?? { kind: "video", tracks: ["V1"] })).find((x) => x.video && x.media);
          if (!c) throw new BridgeError("NO_CLIPS_MATCHED", "No video clip to reframe.");
          const pr: any = await media.probe(c.media);
          const vs = pr.streams.find((s: any) => s.type === "video");
          const sw = vs.width;
          const sh = vs.height;
          const scale = ae.r3(Math.max(W / sw, H / sh) * 100);
          const maxShift = ((sw * scale) / 100 - W) / 2;
          const posFor = (x: number) => ae.r3(Math.max(W / 2 - maxShift, Math.min(W / 2 + maxShift, W / 2 + (sw / 2 - x) * (scale / 100))));
          const pts: { t: number; x: number }[] = [];
          if ((a.method ?? (a.speakers ? "audio" : "frames")) === "audio") {
            if (!a.speakers?.length) throw new BridgeError("BAD_ARGS", "speakers [{x, audio}] are required for method audio.");
            const envs: number[][] = [];
            const hop = 0.1;
            for (const s of a.speakers) {
              const ac = (await sources(a.sequence, s.audio)).find((x) => !x.video && x.media);
              if (!ac) throw new BridgeError("NO_AUDIO", "A speaker has no audio clip.");
              const env = await an.envelope(ac.media, hop, ac.in, ac.out - ac.in);
              const row: number[] = [];
              for (let t = c.start; t < c.end; t += hop) {
                const i = Math.floor((t - ac.start) / hop);
                row.push(i >= 0 && i < env.db.length ? env.db[i] : -120);
              }
              envs.push(row);
            }
            for (const s of ae.chooseAngles(envs, hop, a.min_shot ?? 1.5)) pts.push({ t: s.start, x: a.speakers[s.angle].x }, { t: Math.max(s.start, s.end - 0.3), x: a.speakers[s.angle].x });
          } else {
            // Frames: the horizontal centroid of detail (edges) every 0.5 s.
            const step = 0.5;
            const times: number[] = [];
            for (let t = c.in; t < c.out; t += step) times.push(ae.r3(t));
            const dir = path.join(os.tmpdir(), "premiere-mcp-plus", "reframe");
            ensureOutputDir(dir);
            const files = await media.extractFrames(c.media, times.slice(0, 120), dir);
            const xs: number[] = [];
            for (const f of files) {
              const { data, info } = await sharp(f).greyscale().resize({ width: 160 }).raw().toBuffer({ resolveWithObject: true });
              let sum = 0;
              let wsum = 0;
              for (let y = 1; y < info.height - 1; y++)
                for (let x = 1; x < info.width - 1; x++) {
                  const g = Math.abs(data[y * info.width + x + 1] - data[y * info.width + x - 1]) + Math.abs(data[(y + 1) * info.width + x] - data[(y - 1) * info.width + x]);
                  sum += g * x;
                  wsum += g;
                }
              xs.push(wsum ? (sum / wsum / info.width) * sw : sw / 2);
              fs.rmSync(f, { force: true });
            }
            ae.smooth(xs, 2).forEach((x, i) => pts.push({ t: toSeq(c, times[i]), x }));
          }
          const keys = pts.map((p) => ({ t: ae.r3(Math.max(0, p.t - c.start)), v: [posFor(p.x), H / 2], interp: "ease" as const }));
          if (a.preview) return { preview: true, scale, keys: keys.length, sample: keys.slice(0, 10) };
          await call("set_transform", { sequence: a.sequence, clips: c.id, scale });
          const r: any = await call("add_keyframes", { sequence: a.sequence, clips: c.id, animations: [{ property: "Position", unit: "px", replace: true, keys }] });
          return { clip: c.id, scale, keys: keys.length, verified: !r.errors.length && r.results[0]?.keys === keys.length };
        }
        // ------------------------------------------------------------ 7 shorts
        case "shorts": {
          const src = (await sources(a.sequence, a.clips ?? { kind: "video", tracks: ["V1"] })).filter((x) => x.video && x.media);
          if (!src.length) throw new BridgeError("NO_CLIPS_MATCHED", "No source video clip.");
          const c = src.sort((x, y) => y.end - y.start - (x.end - x.start))[0];
          const env = await an.envelope(c.media, 0.1, c.in, c.out - c.in);
          let words: any[] = [];
          try {
            // The source's own audio (its linked clip), unless voice is given.
            words = (await transcriptFor({ ...a, voice: a.voice ?? { kind: "audio", at: ae.r3((c.start + c.end) / 2) } })).words;
          } catch (e: any) {
            if (!["TRANSCRIBER_MISSING", "NO_AUDIO"].includes(e.code)) throw e;
          }
          const len = a.length ?? 45;
          const picks = ae
            .rankWindows({ duration: c.end - c.start, length: Math.min(len, c.end - c.start), step: 2, envelope: env, words: words.map((w) => ({ ...w, start: w.start - c.start, end: w.end - c.start })), keywords: a.keywords })
            .slice(0, a.count ?? 3);
          if (a.preview) return { preview: true, source: c.id, candidates: picks.map((p) => ({ ...p, start: ae.r3(p.start + c.start), end: ae.r3(p.end + c.start) })) };
          const made: any[] = [];
          const base: any = await call("get_sequence_settings", { sequence: a.sequence });
          for (const [i, p] of picks.entries()) {
            prog(i / picks.length, `short ${i + 1}`);
            const name = `${a.name || base.name} short ${i + 1}`;
            await call("create_sequence", { name, width: 1080, height: 1920, fps: base.fps });
            const mIn = c.in + p.start * (c.speed || 1);
            const pl: any = await call("place_clips", { sequence: name, clips: [{ item: c.item, track: "V1", audio_track: "A1", start: 0, in: ae.r3(mIn), out: ae.r3(mIn + (p.end - p.start) * (c.speed || 1)) }] });
            const vid = pl.placed[0]?.id;
            if (vid) await run("auto_edit", { action: "speaker_reframe", sequence: name, clips: vid, method: "frames" }).catch(() => call("set_transform", { sequence: name, clips: vid, scale: ae.r3((1920 / 1080) * 100) }));
            let captions = 0;
            const ws = words.filter((w) => w.start >= c.start + p.start && w.end <= c.start + p.end).map((w) => ({ ...w, start: ae.r3(w.start - c.start - p.start), end: ae.r3(w.end - c.start - p.start) }));
            if (ws.length) {
              const tf = path.join(bridge.dir, "transcripts", `short_${Date.now().toString(36)}_${i}.json`);
              fs.writeFileSync(tf, JSON.stringify({ words: ws, segments: [] }));
              const cr: any = await run("captions", { action: "burn_style", sequence: name, source: tf, word_highlight: true, track: "V2", style: { uppercase: true } });
              captions = cr.cards;
            }
            if (a.cta) await run("create_title_image", { output: path.join(bridge.dir, "titles", `cta_${i}.png`), width: 1080, height: 1920, template: "center_title", lines: [{ text: a.cta }], place: { sequence: name, track: "V3", start: Math.max(0, ae.r3(p.end - p.start - 2)), duration: 2 }, animate: { in: "pop" }, preview: false });
            const tlr: any = await call("get_timeline", { sequence: name, compact: true });
            const item: any = { sequence: name, start: ae.r3(c.start + p.start), end: ae.r3(c.start + p.end), score: p.score, captions, duration: tlr.duration };
            if (a.export) {
              const ex: any = await run("deliver", { action: "export", sequences: [name], platform: "shorts", folder: a.folder });
              item.file = ex.files[0]?.path;
              item.conformant = ex.files[0]?.conformant;
            }
            made.push(item);
          }
          return { shorts: made, verified: made.every((m) => Math.abs(m.duration - (m.end - m.start)) < 0.2) };
        }
        // ------------------------------------------------------------ 8 chapters
        case "chapters": {
          const st: any = await call("get_sequence_settings", { sequence: a.sequence });
          let chapters: { time: number; title: string }[];
          if (a.from === "markers") {
            const ms: any = await call("list_markers", { sequence: a.sequence });
            chapters = ms.markers.map((m: any) => ({ time: m.start, title: m.name || "Chapter" }));
          } else {
            const tr = await transcriptFor(a);
            chapters = ae.chaptersFrom(tr.segments, a.count ?? Math.max(3, Math.floor(st.duration / 60) + 1), a.min_length ?? 10, st.duration);
          }
          chapters.sort((x, y) => x.time - y.time);
          if (chapters.length && chapters[0].time > 0.5) chapters.unshift({ time: 0, title: "Intro" });
          const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
          const text = chapters.map((c) => `${mmss(c.time)} ${c.title}`).join("\n");
          if (a.preview || a.from === "markers") return { preview: !!a.preview, chapters, text };
          const r: any = await call("add_markers", { sequence: a.sequence, markers: chapters.map((c) => ({ time: c.time, name: c.title, type: "chapter" })) });
          return { chapters, text, markers: r.added.length, verified: r.added.length === chapters.length, warning: chapters.length < 3 ? "YouTube needs at least 3 chapters." : undefined };
        }
        // ------------------------------------------------------------ 9 mix: voice, ducking, loudness
        case "mix": {
          const voice = a.voice ?? { kind: "audio", tracks: ["A1"] };
          const music = a.music ?? { kind: "audio", tracks: ["A2"] };
          const target = a.target_lufs ?? -14;
          const tp = a.true_peak ?? -1;
          if (a.preview) return { preview: true, steps: [`normalize voice to ${a.voice_lufs ?? -16} LUFS`, `duck music ${a.duck_db ?? -12} dB under the voice`, `measure an export and set the mix to ${target} LUFS / ${tp} dBTP`] };
          prog(0.1, "normalize voice");
          const nv: any = await run("audio", { action: "normalize", sequence: a.sequence, clips: voice, target_lufs: a.voice_lufs ?? -16 });
          prog(0.3, "duck music");
          const dk: any = await run("audio", { action: "duck", sequence: a.sequence, voice, music, duck_db: a.duck_db ?? -12 }).catch((e: any) => ({ error: e.message }));
          const wav = media.findExportPresets("Waveform Audio").find((p) => /48/.test(p.name))?.path || media.findExportPresets("Waveform Audio")[0]?.path;
          if (!wav) throw new BridgeError("PRESET_NOT_FOUND", "No 'Waveform Audio' export preset to measure the mix.");
          const dir = path.join(os.tmpdir(), "premiere-mcp-plus", "mix");
          ensureOutputDir(dir);
          let lastFile = "";
          const measure = async (n: number) => {
            const r: any = await run("export_sequence", { sequence: a.sequence, output: path.join(dir, `mix_${Date.now()}_${n}.wav`), preset_path: wav });
            lastFile = r.path;
            return an.loudnessOf(r.path);
          };
          prog(0.5, "measure");
          const m1 = await measure(1);
          if (m1.lufs === null) throw new BridgeError("MEASURE_FAILED", "Could not measure the mix loudness.");
          // Gain that reaches the target without passing the true-peak limit.
          let gain = target - m1.lufs;
          if (m1.truePeak !== null && m1.truePeak + gain > tp) gain = tp - m1.truePeak;
          gain = ae.r3(Math.max(-30, Math.min(30, gain)));
          prog(0.7, "apply gain");
          const all: any = await call("find_clips", { sequence: a.sequence, clips: { kind: "audio" } });
          const ids = all.clips.filter((x: any) => !x.disabled).map((x: any) => x.id);
          // Amplify on every audio clip keeps each clip's volume keyframes (ducking) intact.
          const cur = (await call("get_clip_effects", { sequence: a.sequence, clips: ids, include_values: true, limit: 500 })) as any;
          for (const cl of cur.clips) {
            const amp = cl.components.find((x: any) => x.name === "Amplify")?.props.find((p: any) => /gain/i.test(p.name));
            const now = amp ? 144 * amp.value - 96 : 0;
            await call("audio_tools", { sequence: a.sequence, action: "gain", clips: cl.id, db: ae.r3(now + gain), include_linked: false });
          }
          prog(0.85, "verify");
          const m2 = await measure(2);
          const ok = m2.lufs !== null && m2.truePeak !== null && m2.truePeak <= tp + 0.15 && (Math.abs(m2.lufs - target) <= 1 || m2.truePeak >= tp - 0.3);
          // export / folder: keep the measured mix (the file the numbers above come from).
          let file: string | undefined;
          if ((a.export || a.folder) && lastFile && fs.existsSync(lastFile)) {
            const outDir = path.resolve(a.folder || path.dirname(lastFile));
            ensureOutputDir(outDir);
            const seqName = String(((await call("get_sequence_settings", { sequence: a.sequence })) as any).name || "sequence").replace(/[\\/:*?"<>|]+/g, "_");
            file = path.join(outDir, `${seqName}_mix.wav`);
            fs.copyFileSync(lastFile, file);
          }
          return { file, voice: nv.clips?.map((c: any) => ({ id: c.id, setDb: c.setDb })), ducking: dk.music ? dk.music.length : dk, before: m1, gainDb: gain, after: m2, target: { lufs: target, truePeak: tp }, verified: ok, note: m2.lufs !== null && Math.abs(m2.lufs - target) > 1 ? "The true-peak limit stopped the gain before the loudness target; add a limiter (audio effect Hard Limiter) for more loudness." : undefined };
        }
        // ------------------------------------------------------------ 10 sync external audio
        case "sync_audio": {
          if (!a.file) throw new BridgeError("BAD_ARGS", "file (the external recording) is required.");
          const ext = path.resolve(a.file);
          const cam = (await sources(a.sequence, a.clips ?? { kind: "audio", tracks: ["A1"] })).find((x) => x.media);
          if (!cam) throw new BridgeError("NO_AUDIO", "No camera clip with audio.");
          const s = await an.syncOffset(cam.media, ext, 60);
          // External time = camera media time - offset.
          const extAtStart = cam.in - s.offset;
          const spec: any = { media: "audio" };
          if (extAtStart >= 0) Object.assign(spec, { start: cam.start, in: ae.r3(extAtStart) });
          else Object.assign(spec, { start: ae.r3(cam.start - extAtStart / (cam.speed || 1)), in: 0 });
          // Default track: the first audio track free over the whole placement, else a new one.
          if (a.track) spec.track = a.track;
          else {
            const extDur = (await media.probe(ext)).duration || 0;
            const span = { start: spec.start, end: spec.start + Math.max(0, extDur - spec.in) };
            const st: any = await call("get_sequence_settings", { sequence: a.sequence });
            const all: any = await call("find_clips", { sequence: a.sequence, clips: { kind: "audio" } });
            const busy = new Set(all.clips.filter((c: any) => c.start < span.end - 0.01 && c.end > span.start + 0.01).map((c: any) => String(c.track).toUpperCase()));
            let n = 1;
            while (n <= st.audioTracks && busy.has(`A${n}`)) n++;
            spec.track = `A${n}`;
          }
          if (a.preview) return { preview: true, offset: s.offset, confidence: s.confidence, placement: spec };
          const imp: any = await call("import_files", { paths: [ext], bin: "_MCP Plus/Synced audio" });
          const pl: any = await call("place_clips", { sequence: a.sequence, clips: [{ ...spec, item: imp.imported[0].id }], auto_create_tracks: true });
          return { offset: s.offset, confidence: s.confidence, placed: pl.placed[0], errors: pl.errors, verified: pl.placed.length === 1 && (s.confidence ?? 0) > 1.5, warning: (s.confidence ?? 0) > 1.5 ? undefined : "Low correlation confidence: check the recordings match." };
        }
        // ------------------------------------------------------------ 11 visual QA
        case "visual_qa": {
          const h: any = await run("inspect", { action: "health", sequence: a.sequence, limit: a.count ?? 60 });
          const gaps: any = await call("timeline_summary", { sequence: a.sequence, mode: "gaps" });
          const issues: any[] = [...h.issues, ...(gaps.gapList || []).filter((g: any) => /^V1$/.test(g.track)).map((g: any) => ({ type: "gap", track: g.track, at: g.start, duration: g.duration }))];
          if (a.captions_source) {
            const z: any = await run("captions", { action: "safe_zone_check", sequence: a.sequence, source: a.captions_source, platform: a.platform });
            for (const i of z.issues) issues.push({ type: "caption_outside_safe_zone", at: i.start, platform: z.platform });
          }
          issues.sort((x, y) => x.at - y.at);
          const st: any = await call("get_sequence_settings", { sequence: a.sequence });
          const tc = (t: number) => {
            const f = Math.round(t * st.fps);
            const fr = Math.round(st.fps);
            const p = (n: number) => String(n).padStart(2, "0");
            return `${p(Math.floor(f / (fr * 3600)))}:${p(Math.floor(f / (fr * 60)) % 60)}:${p(Math.floor(f / fr) % 60)}:${p(f % fr)}`;
          };
          const list = issues.map((i) => ({ ...i, timecode: tc(i.at) }));
          const sheet: any = await run("review", { sequence: a.sequence, by: "interval", every: Math.max(2, st.duration / 12), max: 12 });
          const text = { issues: list, count: list.length, byType: list.reduce((m: any, i) => ((m[i.type] = (m[i.type] || 0) + 1), m), {}), checkedClips: h.checkedClips };
          if (sheet?.content) {
            sheet.content[0] = { type: "text", text: JSON.stringify(text) };
            return sheet;
          }
          return text;
        }
        // ------------------------------------------------------------ 13 paper edit
        case "paper_edit": {
          if (!a.script?.length) throw new BridgeError("BAD_ARGS", "script (lines) is required.");
          const tr = await transcriptFor(a);
          const hits = ae.matchLines(a.script, tr.words);
          // Map transcript times to media times of a project item.
          let item = a.item;
          let toMedia = (t: number) => t;
          if (tr.source?.kind === "sequence" && !a.item) {
            const p = tr.source.parts[0];
            const recs: any = await call("media_items", {});
            const it = recs.items.find((x: any) => (x.media || "").toLowerCase() === String(p.file).toLowerCase());
            if (!it) throw new BridgeError("ITEM_NOT_FOUND", "The transcript's media is not in the project.", "Pass item.");
            item = it.id;
            toMedia = (t: number) => (t - p.offset) * p.speed;
          } else if (!item) {
            const recs: any = await call("media_items", {});
            const it = recs.items.find((x: any) => (x.media || "").toLowerCase() === String(tr.source?.file || "").toLowerCase());
            if (!it) throw new BridgeError("BAD_ARGS", "Pass item (the project item of the transcribed file).");
            item = it.id;
          }
          if (a.preview) return { preview: true, matches: hits };
          const rec: any = await call("media_items", { items: [item] });
          const audioOnly = /.(wav|mp3|m4a|aac|flac|aiff?|ogg)$/i.test(rec.items[0]?.media || "");
          const name = a.name || `Paper edit ${new Date().toTimeString().slice(0, 5)}`;
          const base: any = await call("get_sequence_settings", { sequence: a.sequence }).catch(() => ({ width: 1920, height: 1080, fps: 30 }));
          await call("create_sequence", { name, width: base.width, height: base.height, fps: base.fps });
          const pad = a.padding ?? 0.1;
          let t = 0;
          const clips: any[] = [];
          for (const h of hits.filter((x) => x.ok)) {
            const i0 = Math.max(0, toMedia(h.start) - pad);
            const i1 = toMedia(h.end) + pad;
            clips.push(audioOnly ? { item, track: "A1", media: "audio", start: ae.r3(t), in: ae.r3(i0), out: ae.r3(i1) } : { item, track: "V1", audio_track: "A1", start: ae.r3(t), in: ae.r3(i0), out: ae.r3(i1) });
            t += i1 - i0;
          }
          if (!clips.length) throw new BridgeError("NO_MATCH", "No script line matched the transcript.", "Check the language or lower the wording differences.");
          const pl: any = await call("place_clips", { sequence: name, clips });
          return { sequence: name, matches: hits, placed: pl.placed.length, missing: hits.filter((x) => !x.ok).map((x) => x.line), verified: pl.placed.length === clips.length };
        }
      }
    },
    { async: true, checkpoint: true },
  );

  // ======================================================== 12 recipes
  const recipeDir = path.join(bridge.dir, "recipes");
  const BUILTIN: Record<string, any> = {
    canal_padrao: {
      description: "Vídeo padrão do canal: jump cut, mix (voz -16, ducking, -14 LUFS), legendas com palavra destacada, intro/outro e export.",
      params: { voice_track: "A1", music_track: "A2", intro: "", outro: "", output_folder: "", language: "pt" },
      steps: [
        { tool: "checkpoint", args: { action: "create", label: "antes da receita" } },
        { tool: "auto_edit", args: { action: "jump_cut", voice: { tracks: ["{{voice_track}}"] }, min_silence: 0.6, zoom: 106 } },
        { tool: "auto_edit", args: { action: "mix", voice: { tracks: ["{{voice_track}}"] }, music: { tracks: ["{{music_track}}"] } } },
        { tool: "transcribe", args: { clips: { tracks: ["{{voice_track}}"] }, language: "{{language}}" }, save: "tr" },
        { tool: "captions", args: { action: "burn_style", source: "{{steps.tr.transcript}}", word_highlight: true, track: "V3", style: { uppercase: true } } },
        { tool: "deliver", args: { action: "export", platform: "youtube", folder: "{{output_folder}}" }, when: "output_folder" },
      ],
    },
  };
  const loadRecipes = () => {
    const out: Record<string, any> = { ...BUILTIN };
    if (fs.existsSync(recipeDir)) for (const f of fs.readdirSync(recipeDir)) if (f.endsWith(".json")) try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(recipeDir, f), "utf-8")); } catch { /* skip */ }
    return out;
  };
  const fill = (v: any, vars: Record<string, any>): any => {
    if (typeof v === "string") {
      const whole = /^\{\{([\w.]+)\}\}$/.exec(v);
      const get = (k: string) => k.split(".").reduce((o: any, p) => (o == null ? o : o[p]), vars);
      if (whole) return get(whole[1]);
      return v.replace(/\{\{([\w.]+)\}\}/g, (_m, k) => String(get(k) ?? ""));
    }
    if (Array.isArray(v)) return v.map((x) => fill(x, vars));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
    return v;
  };
  async function runRecipe(name: string, params: any, sequence?: string, jctx?: any) {
    const r = loadRecipes()[name];
    if (!r) throw new BridgeError("RECIPE_NOT_FOUND", `No recipe '${name}'.`, "recipes action 'list'.");
    const vars: any = { ...(r.params || {}), ...(params || {}), steps: {} };
    const results: any[] = [];
    const known = Object.keys(r.params || {});
    const unknown = Object.keys(params || {}).filter((k) => !known.includes(k));
    const warning = unknown.length ? `Unknown params ignored: ${unknown.join(", ")}. This recipe takes: ${known.join(", ")}.` : undefined;
    for (const [i, s] of r.steps.entries()) {
      jctx?.progress?.(i / r.steps.length, `${s.tool}`);
      if (s.when && !fill(`{{${s.when}}}`, vars)) {
        results.push({ step: i, tool: s.tool, skipped: true, reason: `param '${s.when}' is empty; pass params.${s.when} to run this step` });
        continue;
      }
      const args = fill(s.args || {}, vars);
      if (sequence && args.sequence === undefined && !["transcribe", "jobs"].includes(s.tool)) args.sequence = sequence;
      const t = registry.get(s.tool);
      if (!t) throw new BridgeError("BAD_RECIPE", `Step ${i}: unknown tool ${s.tool}.`);
      const parsed = t.schema.safeParse(args);
      if (!parsed.success) throw new BridgeError("BAD_RECIPE", `Step ${i} (${s.tool}): ${parsed.error.issues.map((x: any) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
      try {
        let out: any = await t.handler(parsed.data);
        if (out && Array.isArray(out.content)) out = JSON.parse(out.content.find((c: any) => c.type === "text")?.text || "{}");
        if (s.save) vars.steps[s.save] = out;
        if (out?.status === "needs_confirmation") {
          results.push({ step: i, tool: s.tool, ok: false, status: "needs_confirmation", hint: out.hint, preview: out.preview });
          return { recipe: name, results, completed: false, warning, note: `Step ${i} (${s.tool}) needs confirmation. Review the preview, then run that step by hand with its confirm_token, or raise max_cut in the recipe.` };
        }
        results.push({ step: i, tool: s.tool, ok: true, status: out?.status ?? (out?.verified === false ? "failed" : out?.verified ? "verified" : undefined) });
      } catch (e: any) {
        results.push({ step: i, tool: s.tool, ok: false, code: e.code, error: e.message });
        return { recipe: name, results, completed: false, warning };
      }
    }
    return { recipe: name, results, completed: true, warning, verified: results.every((x) => x.ok || x.skipped) };
  }

  tool(
    "recipes",
    "Recipes",
    "Reusable workflows: a JSON list of tool calls with {{param}} placeholders ({{steps.<save>.<field>}} reads an earlier step's result). list, get, save (name, description, params defaults, steps [{tool, args, save?, when?}]), delete, run (params, sequence; async: true for long ones). Built-in: canal_padrao. Recipes are also exposed as MCP prompts and in the resource premiere-plus://recipes.",
    {
      action: z.enum(["list", "get", "save", "delete", "run"]),
      name: z.string().optional(),
      description: z.string().optional(),
      params: z.record(z.string(), z.any()).optional(),
      steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional(), save: z.string().optional(), when: z.string().optional() })).optional(),
      sequence: seqArg,
    },
    ANN.write,
    async (a: any, jctx: any) => {
      const all = loadRecipes();
      if (a.action === "list") return { recipes: Object.entries(all).map(([k, v]: any) => ({ name: k, description: v.description, params: v.params, steps: v.steps.length, builtin: !!BUILTIN[k] })) };
      if (!a.name) throw new BridgeError("BAD_ARGS", "name is required.");
      if (a.action === "get") {
        if (!all[a.name]) throw new BridgeError("RECIPE_NOT_FOUND", `No recipe '${a.name}'.`);
        return { name: a.name, ...all[a.name] };
      }
      if (a.action === "save") {
        if (!a.steps?.length) throw new BridgeError("BAD_ARGS", "steps are required.");
        for (const [i, s] of a.steps.entries()) if (!registry.get(s.tool)) throw new BridgeError("BAD_RECIPE", `Step ${i}: unknown tool ${s.tool}.`);
        ensureOutputDir(recipeDir);
        const file = path.join(recipeDir, `${a.name.replace(/[^\w-]/g, "_")}.json`);
        fs.writeFileSync(file, JSON.stringify({ description: a.description || "", params: a.params || {}, steps: a.steps }, null, 1));
        return { saved: a.name, path: file, verified: fs.existsSync(file) };
      }
      if (a.action === "delete") {
        if (BUILTIN[a.name]) throw new BridgeError("BAD_ARGS", "Built-in recipes cannot be deleted.");
        const file = path.join(recipeDir, `${a.name.replace(/[^\w-]/g, "_")}.json`);
        fs.rmSync(file, { force: true });
        return { deleted: a.name, verified: !fs.existsSync(file) };
      }
      return runRecipe(a.name, a.params, a.sequence, jctx);
    },
    { async: true },
  );

  // Recipes as MCP prompts + a catalog resource.
  try {
    server.registerResource(
      "recipes",
      "premiere-plus://recipes",
      { title: "Premiere recipes", description: "Catalog of saved workflow recipes", mimeType: "application/json" },
      async () => ({ contents: [{ uri: "premiere-plus://recipes", mimeType: "application/json", text: JSON.stringify(loadRecipes(), null, 1) }] }),
    );
    for (const [name, r] of Object.entries(loadRecipes())) {
      server.registerPrompt(
        `recipe_${name}`,
        { title: `Recipe: ${name}`, description: (r as any).description || name, argsSchema: { sequence: z.string().optional(), params: z.string().optional().describe("JSON object of parameters") } },
        (args: any) => ({
          messages: [{ role: "user", content: { type: "text", text: `Run the Premiere recipe "${name}" with the recipes tool (action "run"${args.sequence ? `, sequence "${args.sequence}"` : ""}${args.params ? `, params ${args.params}` : ""}). Report each step's status and any failed step.` } }],
        }),
      );
    }
  } catch {
    /* host without prompts/resources */
  }
}
