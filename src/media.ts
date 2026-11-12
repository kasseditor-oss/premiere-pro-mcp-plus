import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp, { type OverlayOptions } from "sharp";

const run = promisify(execFile);

function which(bin: string): string {
  const env = process.env[`${bin.toUpperCase()}_PATH`];
  if (env && fs.existsSync(env)) return env;
  return bin; // rely on PATH
}

async function ff(args: string[], bin = "ffmpeg", timeout = 600_000): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run(which(bin), args, { maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true });
  } catch (e: any) {
    if (e.code === "ENOENT") throw new Error(`${bin} was not found. Install FFmpeg or set ${bin.toUpperCase()}_PATH.`);
    // ffmpeg writes analysis to stderr and may exit non-zero on harmless warnings
    if (e.stderr) return { stdout: e.stdout || "", stderr: e.stderr };
    throw e;
  }
}

export async function probe(file: string) {
  const { stdout } = await ff(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], "ffprobe");
  const j = JSON.parse(stdout);
  const streams = (j.streams || []).map((s: any) => {
    const base: any = { index: s.index, type: s.codec_type, codec: s.codec_name };
    if (s.codec_type === "video") {
      const [n, d] = String(s.avg_frame_rate || s.r_frame_rate || "0/1").split("/").map(Number);
      Object.assign(base, { width: s.width, height: s.height, fps: d ? Math.round((n / d) * 1000) / 1000 : null, pix_fmt: s.pix_fmt, frames: s.nb_frames ? Number(s.nb_frames) : undefined });
    }
    if (s.codec_type === "audio") Object.assign(base, { sample_rate: Number(s.sample_rate), channels: s.channels, layout: s.channel_layout });
    return base;
  });
  return { file, duration: Number(j.format?.duration || 0), size: Number(j.format?.size || 0), bitrate: Number(j.format?.bit_rate || 0), format: j.format?.format_name, streams };
}

export async function detectSilence(file: string, noiseDb = -35, minDur = 0.4) {
  const { stderr } = await ff(["-hide_banner", "-nostats", "-i", file, "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`, "-f", "null", "-"]);
  const silences: { start: number; end: number; duration: number }[] = [];
  let cur: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) cur = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/.exec(line);
    if (e && cur !== null) {
      silences.push({ start: r3(cur), end: r3(Number(e[1])), duration: r3(Number(e[2])) });
      cur = null;
    }
  }
  return silences;
}

export async function detectScenes(file: string, threshold = 0.3) {
  const { stderr } = await ff(["-hide_banner", "-nostats", "-i", file, "-an", "-vf", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"]);
  const cuts: number[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m && /Parsed_showinfo/.test(line)) cuts.push(r3(Number(m[1])));
  }
  return cuts;
}

export async function loudness(file: string) {
  const { stderr } = await ff(["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    return m ? Number(m[1]) : null;
  };
  return { integratedLUFS: num(/I:\s+(-?[\d.]+) LUFS/), loudnessRangeLU: num(/LRA:\s+(-?[\d.]+) LU/), truePeakDBFS: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

export async function extractFrames(file: string, times: number[], outDir: string) {
  fs.mkdirSync(outDir, { recursive: true });
  const out: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const p = path.join(outDir, `src_${Date.now()}_${i}.png`);
    await ff(["-hide_banner", "-loglevel", "error", "-ss", String(times[i]), "-i", file, "-frames:v", "1", "-y", p]);
    out.push(p);
  }
  return out;
}

/** Downscale for returning to the model (keeps token cost low). */
export async function toPreviewJpeg(file: string, maxWidth = 960, quality = 72): Promise<string> {
  const buf = await sharp(file).resize({ width: maxWidth, withoutEnlargement: true }).flatten({ background: "#000000" }).jpeg({ quality }).toBuffer();
  return buf.toString("base64");
}

/** Grid of frames with a time label under each one. */
export async function contactSheet(files: { path: string; label: string }[], outFile: string, columns = 3, cellWidth = 480): Promise<string> {
  const valid = files.filter((f) => f.path && fs.existsSync(f.path));
  if (!valid.length) throw new Error("No frames were produced to build the contact sheet.");
  const meta = await sharp(valid[0].path).metadata();
  const aspect = (meta.height || 9) / (meta.width || 16);
  const cellH = Math.round(cellWidth * aspect);
  const labelH = 28;
  const rows = Math.ceil(valid.length / columns);
  const W = columns * cellWidth;
  const H = rows * (cellH + labelH);
  const comps: OverlayOptions[] = [];
  for (let i = 0; i < valid.length; i++) {
    const x = (i % columns) * cellWidth;
    const y = Math.floor(i / columns) * (cellH + labelH);
    const img = await sharp(valid[i].path).resize(cellWidth, cellH, { fit: "contain", background: "#000" }).flatten({ background: "#000000" }).png().toBuffer();
    comps.push({ input: img, left: x, top: y });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="${labelH}"><rect width="100%" height="100%" fill="#111"/><text x="8" y="19" font-family="Segoe UI, Arial" font-size="15" fill="#eee">${escapeXml(valid[i].label)}</text></svg>`;
    comps.push({ input: Buffer.from(svg), left: x, top: y + cellH });
  }
  await sharp({ create: { width: W, height: H, channels: 3, background: "#000000" } }).composite(comps).jpeg({ quality: 80 }).toFile(outFile);
  return outFile;
}

export function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function r3(n: number) {
  return Math.round(n * 1000) / 1000;
}

export const MEDIA_EXT = /\.(mp4|mov|mxf|avi|mkv|m4v|webm|mts|m2ts|wmv|mpg|mpeg|r3d|braw|png|jpe?g|tiff?|psd|gif|bmp|webp|exr|tga|ai|svg|wav|mp3|aif+|m4a|flac|ogg|aac|mogrt|prproj|xml|srt|vtt)$/i;

export function listMediaFiles(dir: string, recursive: boolean): { file: string; rel: string }[] {
  const out: { file: string; rel: string }[] = [];
  const walk = (d: string, rel: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (recursive) walk(full, rel ? `${rel}/${ent.name}` : ent.name);
      } else if (MEDIA_EXT.test(ent.name) && !/\.(prproj|xml|srt|vtt|mogrt)$/i.test(ent.name)) out.push({ file: full, rel });
    }
  };
  walk(dir, "");
  return out;
}

export function findExportPresets(filter?: string): { name: string; path: string; source: string }[] {
  const roots = [
    "C:/Program Files/Adobe/Adobe Media Encoder 2026/MediaIO/systempresets",
    "C:/Program Files/Adobe/Adobe Media Encoder 2027/MediaIO/systempresets",
    "C:/Program Files/Adobe/Adobe Media Encoder 2025/MediaIO/systempresets",
    "C:/Program Files/Adobe/Adobe Premiere Pro 2026/MediaIO/systempresets",
    "C:/Program Files/Adobe/Adobe Premiere Pro 2025/MediaIO/systempresets",
    path.join(process.env.USERPROFILE || "", "Documents/Adobe/Adobe Media Encoder"),
    "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets",
    "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MediaIO/systempresets",
  ];
  const re = filter ? new RegExp(filter, "i") : null;
  const seen = new Set<string>();
  const out: { name: string; path: string; source: string }[] = [];
  const walk = (d: string, source: string, depth: number) => {
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(full, source, depth + 1);
      else if (/\.epr$/i.test(e.name)) {
        let name = e.name.replace(/\.epr$/i, "");
        try {
          const head = fs.readFileSync(full, "utf-8").slice(0, 4000);
          const n = /<PresetName>([^<]+)<\/PresetName>/.exec(head) || /<Name>([^<]+)<\/Name>/.exec(head);
          if (n) name = n[1];
          // Localization keys look like "$$$/AME/.../PresetName=H.264 (Match Source)"
          const loc = /PresetName=([^)]*\)?)\)?$/.exec(name) || /=([^=]+)$/.exec(name);
          if (name.startsWith("$$$") || name.startsWith("($$$")) name = (loc ? loc[1] : e.name.replace(/\.epr$/i, "")).replace(/^\(|\)\)$/g, ")").replace(/\)$/, name.endsWith("))") ? ")" : "");
        } catch {
          /* ignore */
        }
        const key = name + "|" + source;
        if (seen.has(key)) continue;
        if (re && !re.test(name) && !re.test(full)) continue;
        seen.add(key);
        out.push({ name, path: full.replace(/\\/g, "/"), source });
      }
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r, r.includes("Media Encoder") ? "Media Encoder" : "Premiere", 0);
  return out;
}

/** Poll until a rendered file is complete (ffprobe reads a duration). */
export async function waitForValidMedia(file: string, timeoutMs: number): Promise<{ valid: boolean; duration?: number; reason?: string }> {
  const end = Date.now() + timeoutMs;
  let reason = "file not found";
  for (;;) {
    if (fs.existsSync(file)) {
      try {
        const { stdout } = await run(which("ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { windowsHide: true, timeout: 30_000 });
        const d = Number(stdout.trim());
        if (d > 0) return { valid: true, duration: Math.round(d * 1000) / 1000 };
        reason = "no duration";
      } catch (e: any) {
        if (e.code === "ENOENT") {
          // No ffprobe: fall back to a size that stays stable for 5 s.
          const a = fs.statSync(file).size;
          await new Promise((r) => setTimeout(r, 5000));
          return fs.statSync(file).size === a && a > 0 ? { valid: true } : { valid: false, reason: "size still changing" };
        }
        reason = String(e.stderr || e.message).split(/\r?\n/).filter(Boolean).pop() || "unreadable";
      }
    }
    if (Date.now() > end) return { valid: false, reason };
    await new Promise((r) => setTimeout(r, 1000));
  }
}
