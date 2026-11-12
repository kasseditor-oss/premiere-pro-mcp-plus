import fs from "node:fs";
import path from "node:path";

/** A clip as get_timeline returns it (non-compact, with media and effects). */
export interface TlClip {
  id: string;
  track: string;
  name: string;
  start: number;
  end: number;
  in: number;
  out: number;
  speed?: number;
  disabled?: boolean;
  reversed?: boolean;
  media?: string;
  item?: string;
  effects?: string[];
}
export interface Timeline {
  id?: string;
  name?: string;
  duration?: number;
  tracks: { track: string; clips: TlClip[] }[];
  markers?: number;
}

export interface Checkpoint {
  id: string;
  createdAt: string;
  sequence: { id: string; name: string };
  clone?: { id: string; name: string };
  label?: string;
  timeline: Timeline;
}

export class CheckpointStore {
  constructor(private dir: string) {}

  private folder() {
    const d = path.join(this.dir, "checkpoints");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  save(cp: Checkpoint) {
    fs.writeFileSync(path.join(this.folder(), `${cp.id}.json`), JSON.stringify(cp), "utf-8");
  }

  get(id: string): Checkpoint | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.folder(), `${id}.json`), "utf-8"));
    } catch {
      return null;
    }
  }

  list(): Omit<Checkpoint, "timeline">[] {
    const out: any[] = [];
    for (const f of fs.readdirSync(this.folder())) {
      if (!f.endsWith(".json")) continue;
      try {
        const cp = JSON.parse(fs.readFileSync(path.join(this.folder(), f), "utf-8")) as Checkpoint;
        const { timeline, ...rest } = cp;
        out.push({ ...rest, clips: timeline.tracks.reduce((n, t) => n + t.clips.length, 0) });
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;
const flat = (t: Timeline) => t.tracks.flatMap((tr) => tr.clips.map((c) => ({ ...c, track: c.track || tr.track })));

/**
 * Compare two timelines: clips added, removed, moved, trimmed or otherwise
 * changed. Clips are matched by id first (same sequence), then by media and
 * source range (a clone has new ids), then by name and overlap.
 */
export function diffTimelines(a: Timeline, b: Timeline) {
  const A = flat(a);
  const B = flat(b);
  const usedB = new Set<number>();
  const pairs: [TlClip, TlClip][] = [];
  const unA: TlClip[] = [];
  const byId = new Map(B.map((c, i) => [c.id, i]));
  for (const c of A) {
    const i = byId.get(c.id);
    if (i !== undefined && !usedB.has(i)) {
      usedB.add(i);
      pairs.push([c, B[i]]);
    } else unA.push(c);
  }
  const pick = (c: TlClip, test: (d: TlClip) => boolean) => {
    let best = -1;
    let bestD = Infinity;
    B.forEach((d, i) => {
      if (usedB.has(i) || !test(d)) return;
      const dist = Math.abs(d.start - c.start) + (d.track === c.track ? 0 : 1000);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    return best;
  };
  const left: TlClip[] = [];
  const src = (c: TlClip) => c.media || c.item || c.name;
  const sameSource = (c: TlClip, d: TlClip) => src(d) === src(c) && near(d.in, c.in) && near(d.out, c.out);
  // Pass 1: clips that did not change at all (same source range, track and start).
  const rest: TlClip[] = [];
  for (const c of unA) {
    const i = pick(c, (d) => sameSource(c, d) && d.track === c.track && near(d.start, c.start));
    if (i < 0) rest.push(c);
    else {
      usedB.add(i);
      pairs.push([c, B[i]]);
    }
  }
  // Pass 2: same source range elsewhere (moved); pass 3: same name overlapping (trimmed).
  for (const c of rest) {
    let i = pick(c, (d) => sameSource(c, d));
    if (i < 0) i = pick(c, (d) => d.name === c.name && (d.media || "") === (c.media || "") && d.track === c.track && d.start < c.end && d.end > c.start);
    if (i < 0) left.push(c);
    else {
      usedB.add(i);
      pairs.push([c, B[i]]);
    }
  }
  const brief = (c: TlClip) => ({ id: c.id, track: c.track, name: c.name, start: r3(c.start), end: r3(c.end) });
  const moved: any[] = [];
  const trimmed: any[] = [];
  const changed: any[] = [];
  for (const [x, y] of pairs) {
    const sameRange = near(x.in, y.in) && near(x.out, y.out) && near(x.end - x.start, y.end - y.start);
    if ((!near(x.start, y.start) || x.track !== y.track) && sameRange) moved.push({ name: y.name, from: { track: x.track, start: r3(x.start) }, to: { track: y.track, start: r3(y.start) }, id: y.id });
    else if (!sameRange) trimmed.push({ name: y.name, id: y.id, track: y.track, before: { start: r3(x.start), end: r3(x.end), in: r3(x.in), out: r3(x.out) }, after: { start: r3(y.start), end: r3(y.end), in: r3(y.in), out: r3(y.out) } });
    const what: string[] = [];
    if ((x.speed || 1) !== (y.speed || 1)) what.push(`speed ${x.speed || 1} -> ${y.speed || 1}`);
    if (!!x.disabled !== !!y.disabled) what.push(y.disabled ? "disabled" : "enabled");
    if (!!x.reversed !== !!y.reversed) what.push(y.reversed ? "reversed" : "unreversed");
    if (x.name !== y.name) what.push(`renamed '${x.name}' -> '${y.name}'`);
    const fx = (l?: string[]) => (l || []).join("|");
    if (fx(x.effects) !== fx(y.effects)) what.push(`effects [${(x.effects || []).join(", ")}] -> [${(y.effects || []).join(", ")}]`);
    if (what.length) changed.push({ name: y.name, id: y.id, track: y.track, changes: what });
  }
  const added = B.filter((_c, i) => !usedB.has(i)).map(brief);
  const removed = left.map(brief);
  return {
    summary: { added: added.length, removed: removed.length, moved: moved.length, trimmed: trimmed.length, changed: changed.length, unchanged: pairs.length - new Set([...moved, ...trimmed, ...changed].map((m) => m.id)).size },
    duration: { before: a.duration, after: b.duration },
    added,
    removed,
    moved,
    trimmed,
    changed,
  };
}
