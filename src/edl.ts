/**
 * CMX3600 EDL writer used when Premiere's own Sequence.exportAsEDL is missing
 * (Premiere 26.x no longer exposes it to ExtendScript). Built from get_timeline.
 */
interface Clip {
  name: string;
  start: number;
  end: number;
  in: number;
  out: number;
  speed?: number;
  media?: string;
  disabled?: boolean;
}
interface Track {
  track: string;
  clips: Clip[];
}
export interface TimelineSnapshot {
  name: string;
  fps: number;
  tracks: Track[];
}

function tc(seconds: number, fps: number): string {
  const nominal = Math.round(fps);
  const frames = Math.max(0, Math.round(seconds * fps));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(frames / (nominal * 3600)))}:${p(Math.floor(frames / (nominal * 60)) % 60)}:${p(Math.floor(frames / nominal) % 60)}:${p(frames % nominal)}`;
}

function reel(media: string | undefined, name: string): string {
  const base = (media ? media.split(/[\\/]/).pop()! : name).replace(/\.[^.]+$/, "");
  return (base.replace(/[^A-Za-z0-9_]/g, "").toUpperCase() || "AX").slice(0, 8).padEnd(8, " ");
}

export function buildEdl(tl: TimelineSnapshot, opts: { videoTrack?: string; audioTracks?: string[] } = {}): { text: string; events: number } {
  const fps = tl.fps || 30;
  const vt = (opts.videoTrack || "V1").toUpperCase();
  const ats = (opts.audioTracks || ["A1", "A2"]).map((t) => t.toUpperCase());
  const lines = [`TITLE: ${tl.name.slice(0, 70)}`, "FCM: NON-DROP FRAME", ""];
  let n = 0;
  const emit = (c: Clip, kind: string) => {
    if (c.disabled) return;
    n++;
    const speed = c.speed && c.speed > 0 ? c.speed : 1;
    const srcIn = c.in; // get_timeline reports media seconds (already multiplied by speed)
    const srcOut = srcIn + (c.end - c.start) * speed;
    lines.push(`${String(n).padStart(3, "0")}  ${reel(c.media, c.name)} ${kind.padEnd(5, " ")} C        ${tc(srcIn, fps)} ${tc(srcOut, fps)} ${tc(c.start, fps)} ${tc(c.end, fps)}`);
    if (speed !== 1) lines.push(`M2   ${reel(c.media, c.name)}       ${(fps * speed).toFixed(1).padStart(5, "0")}                ${tc(srcIn, fps)}`);
    lines.push(`* FROM CLIP NAME: ${c.name}`);
    if (c.media) lines.push(`* SOURCE FILE: ${c.media}`);
    lines.push("");
  };
  const v = tl.tracks.find((t) => t.track === vt);
  for (const c of v?.clips ?? []) emit(c, "V");
  ats.forEach((at, i) => {
    const t = tl.tracks.find((x) => x.track === at);
    for (const c of t?.clips ?? []) emit(c, i === 0 ? "A" : i === 1 ? "A2" : `A${i + 1}`);
  });
  return { text: lines.join("\r\n"), events: n };
}
