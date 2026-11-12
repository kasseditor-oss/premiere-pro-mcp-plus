// Pure planning helpers for the Phase 3 automatic edits (no Premiere calls here).
export const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface Range {
  start: number;
  end: number;
}
export interface Word {
  start: number;
  end: number;
  word: string;
}

/** Merge overlapping / touching ranges. */
export function mergeRanges(list: Range[], join = 0): Range[] {
  const s = [...list].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + join) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out.map((r) => ({ start: r3(r.start), end: r3(r.end) }));
}

/** Gaps between active regions inside [from, to], shrunk by padding on both sides. */
export function silencesBetween(active: Range[], from: number, to: number, minSilence: number, padding: number): Range[] {
  const out: Range[] = [];
  let cur = from;
  for (const r of [...active].sort((a, b) => a.start - b.start)) {
    if (r.start - cur >= minSilence) out.push({ start: cur + (cur === from ? 0 : padding), end: r.start - padding });
    cur = Math.max(cur, r.end);
  }
  if (to - cur >= minSilence) out.push({ start: cur + padding, end: to });
  return out.filter((r) => r.end - r.start > 0.04).map((r) => ({ start: r3(r.start), end: r3(r.end) }));
}

export const FILLERS: Record<string, string[]> = {
  pt: ["é", "éé", "ééé", "eh", "ãh", "ã", "ah", "ahn", "hum", "hmm", "uhm", "tipo", "né", "assim", "então", "bom", "enfim"],
  en: ["um", "uh", "uhm", "umm", "erm", "er", "ah", "hmm", "like", "you know", "i mean", "so", "basically", "actually"],
};
export const norm = (w: string) =>
  w
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}' ]/gu, "")
    .trim();

/** Filler words (single or two-word) in a transcript; conservative words only when isolated by pauses. */
export function fillerRanges(words: Word[], list: string[], soft: string[] = ["like", "so", "tipo", "assim", "entao", "bom", "basically", "actually", "enfim"]): (Range & { word: string })[] {
  const set = new Set(list.map(norm));
  const softSet = new Set(soft.map(norm));
  const out: (Range & { word: string })[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = norm(words[i].word);
    const two = i + 1 < words.length ? `${w} ${norm(words[i + 1].word)}` : "";
    if (two && set.has(two)) {
      out.push({ start: words[i].start, end: words[i + 1].end, word: two });
      i++;
      continue;
    }
    if (!set.has(w)) continue;
    if (softSet.has(w)) {
      // "like" / "tipo" are fillers only with a pause around them or a comma in the transcript.
      const gapBefore = i > 0 ? words[i].start - words[i - 1].end : 1;
      const gapAfter = i + 1 < words.length ? words[i + 1].start - words[i].end : 1;
      if (!(gapBefore > 0.25 || gapAfter > 0.25 || /,$/.test(words[i].word))) continue;
    }
    out.push({ start: words[i].start, end: words[i].end, word: w });
  }
  return out.map((r) => ({ ...r, start: r3(r.start), end: r3(r.end) }));
}

/** Pauses between words longer than maxPause, shortened so keep seconds remain. */
export function longPauses(words: Word[], maxPause: number, keep: number): Range[] {
  const out: Range[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > maxPause) out.push({ start: r3(words[i - 1].end + keep / 2), end: r3(words[i].start - keep / 2) });
  }
  return out;
}

/** Word-set similarity (Dice) of two texts. */
export function similarity(a: string, b: string) {
  const A = norm(a).split(/\s+/).filter(Boolean);
  const B = norm(b).split(/\s+/).filter(Boolean);
  if (!A.length || !B.length) return 0;
  const bs = new Map<string, number>();
  for (const w of B) bs.set(w, (bs.get(w) || 0) + 1);
  let hit = 0;
  for (const w of A) {
    const n = bs.get(w) || 0;
    if (n) {
      hit++;
      bs.set(w, n - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

/** Repeated takes: a segment almost equal to the next one (or the one after) is dropped, keeping the last. */
export function repeatedTakes(segments: { start: number; end: number; text: string }[], threshold = 0.8) {
  const drop: (Range & { text: string; keptAt: number })[] = [];
  for (let i = 0; i < segments.length; i++) {
    for (let k = i + 1; k <= i + 2 && k < segments.length; k++) {
      if (norm(segments[i].text).split(/\s+/).length < 3) continue;
      if (similarity(segments[i].text, segments[k].text) >= threshold) {
        drop.push({ start: segments[i].start, end: segments[k].start, text: segments[i].text, keptAt: segments[k].start });
        break;
      }
    }
  }
  return drop;
}

/** Shot selection for multicam: loudest speaker per window, with a minimum shot length. */
export function chooseAngles(energy: number[][], hop: number, minShot: number, bias = 3) {
  const n = Math.min(...energy.map((e) => e.length));
  const shots: { angle: number; start: number; end: number }[] = [];
  let cur = -1;
  let since = 0;
  for (let i = 0; i < n; i++) {
    let best = 0;
    for (let a = 1; a < energy.length; a++) if (energy[a][i] > energy[best][i]) best = a;
    const t = i * hop;
    if (cur < 0) {
      cur = best;
      since = t;
      continue;
    }
    // Switch only when the other speaker is clearly louder and the shot is long enough.
    if (best !== cur && energy[best][i] > energy[cur][i] + bias && t - since >= minShot) {
      shots.push({ angle: cur, start: r3(since), end: r3(t) });
      cur = best;
      since = t;
    }
  }
  if (cur >= 0) shots.push({ angle: cur, start: r3(since), end: r3(n * hop) });
  return shots;
}

/** Moving average for smoothing tracking positions. */
export function smooth(v: number[], k = 2) {
  return v.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(v.length - 1, i + k); j++) {
      s += v[j];
      n++;
    }
    return s / n;
  });
}

/** Rank candidate windows for Shorts by audio energy, speech density and keywords. */
export function rankWindows(opts: { duration: number; length: number; step: number; envelope: { hop: number; db: number[] }; words?: Word[]; keywords?: string[] }) {
  const { duration, length, step, envelope, words = [], keywords = [] } = opts;
  const kw = keywords.map(norm);
  const out: { start: number; end: number; score: number; energy: number; wordsPerSec: number; keywords: number }[] = [];
  for (let s = 0; s + length <= duration + 0.001; s += step) {
    const e = s + length;
    const i0 = Math.floor(s / envelope.hop);
    const i1 = Math.min(envelope.db.length, Math.floor(e / envelope.hop));
    let lin = 0;
    for (let i = i0; i < i1; i++) lin += Math.pow(10, envelope.db[i] / 20);
    const energy = i1 > i0 ? 20 * Math.log10(lin / (i1 - i0) + 1e-9) : -99;
    const ws = words.filter((w) => w.start >= s && w.end <= e);
    const k = ws.filter((w) => kw.includes(norm(w.word))).length;
    out.push({ start: r3(s), end: r3(e), score: 0, energy: r3(energy), wordsPerSec: r3(ws.length / length), keywords: k });
  }
  const maxE = Math.max(...out.map((o) => o.energy));
  const maxW = Math.max(0.01, ...out.map((o) => o.wordsPerSec));
  for (const o of out) o.score = r3((o.energy - maxE) / 20 + o.wordsPerSec / maxW + o.keywords * 0.5);
  out.sort((a, b) => b.score - a.score);
  // Non-overlapping picks.
  const picks: typeof out = [];
  for (const o of out) if (!picks.some((p) => o.start < p.end && o.end > p.start)) picks.push(o);
  return picks;
}

/** Chapters from a transcript: split at the longest pauses, titles from the first words. */
export function chaptersFrom(segments: { start: number; end: number; text: string }[], count: number, minLen: number, total: number) {
  const gaps = segments.slice(1).map((s, i) => ({ at: s.start, gap: s.start - segments[i].end }));
  gaps.sort((a, b) => b.gap - a.gap);
  const cuts: number[] = [0];
  for (const g of gaps) {
    if (cuts.length >= count) break;
    if (cuts.every((c) => Math.abs(c - g.at) >= minLen) && total - g.at >= minLen) cuts.push(g.at);
  }
  cuts.sort((a, b) => a - b);
  return cuts.map((c, i) => {
    const seg = segments.find((s) => s.start >= c - 0.01) || segments[0];
    const title = (seg?.text || "Chapter").replace(/[.!?,].*$/, "").split(/\s+/).slice(0, 6).join(" ");
    return { time: r3(c), end: r3(cuts[i + 1] ?? total), title: title.charAt(0).toUpperCase() + title.slice(1) };
  });
}

/** Paper edit: best matching transcript span for each script line (word overlap). */
export function matchLines(lines: string[], words: Word[], minScore = 0.5) {
  const W = words.map((w) => ({ ...w, n: norm(w.word) }));
  return lines.map((line) => {
    const target = norm(line).split(/\s+/).filter(Boolean);
    const len = target.length;
    let best = { score: 0, start: 0, end: 0, text: "" };
    for (let i = 0; i < W.length; i++) {
      for (const L of [len - 1, len, len + 1, len + 2]) {
        if (L < 1 || i + L > W.length) continue;
        const span = W.slice(i, i + L);
        const sc = similarity(target.join(" "), span.map((x) => x.n).join(" "));
        if (sc > best.score + 1e-9 || (Math.abs(sc - best.score) < 1e-9 && span[0].start > best.start)) best = { score: sc, start: span[0].start, end: span[span.length - 1].end, text: span.map((x) => x.word).join(" ") };
      }
    }
    return { line, ...best, score: r3(best.score), ok: best.score >= minScore };
  });
}
