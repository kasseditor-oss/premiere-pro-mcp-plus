import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

async function ff(args: string[], timeout = 900_000): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("ffmpeg", args, { maxBuffer: 256 * 1024 * 1024, timeout, windowsHide: true });
  } catch (e: any) {
    if (e?.stderr !== undefined && e?.code !== "ENOENT") return { stdout: e.stdout || "", stderr: e.stderr || "" };
    throw Object.assign(new Error("FFmpeg is not installed or not on PATH."), { code: "FFMPEG_MISSING", hint: "Install FFmpeg (winget install ffmpeg) and restart." });
  }
}

const range = (start?: number, dur?: number) => [...(start ? ["-ss", String(start)] : []), ...(dur ? ["-t", String(dur)] : [])];

/** Decode audio to mono float samples at `rate` Hz (for envelopes / correlation). */
export function decodePcm(file: string, rate = 8000, start?: number, dur?: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...range(start, dur), "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { windowsHide: true });
    const chunks: Buffer[] = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", (e: any) => reject(e?.code === "ENOENT" ? Object.assign(new Error("FFmpeg is not installed."), { code: "FFMPEG_MISSING" }) : e));
    p.on("close", () => {
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

/** RMS envelope in dBFS, one value per `hop` seconds. */
export async function envelope(file: string, hop = 0.02, start?: number, dur?: number): Promise<{ hop: number; db: number[] }> {
  const rate = 8000;
  const pcm = await decodePcm(file, rate, start, dur);
  const n = Math.max(1, Math.round(hop * rate));
  const db: number[] = [];
  for (let i = 0; i + n <= pcm.length; i += n) {
    let s = 0;
    for (let k = i; k < i + n; k++) s += pcm[k] * pcm[k];
    const rms = Math.sqrt(s / n);
    db.push(rms > 1e-7 ? 20 * Math.log10(rms) : -140);
  }
  return { hop, db };
}

/** Speech / sound regions from an envelope: spans above threshold, joined across short dips. */
export function activeRegions(env: { hop: number; db: number[] }, thresholdDb: number, minSilence = 0.3, minActive = 0.08) {
  const out: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  env.db.forEach((v, i) => {
    const t = i * env.hop;
    if (v > thresholdDb) {
      if (cur && t - cur.end <= minSilence) cur.end = t + env.hop;
      else {
        if (cur) out.push(cur);
        cur = { start: t, end: t + env.hop };
      }
    }
  });
  if (cur) out.push(cur);
  return out.filter((r) => r.end - r.start >= minActive).map((r) => ({ start: r3(r.start), end: r3(r.end) }));
}

/** Noise floor estimate (10th percentile of the envelope) and a speech threshold above it. */
export function autoThreshold(env: { db: number[] }) {
  const s = [...env.db].filter((v) => v > -120).sort((a, b) => a - b);
  if (!s.length) return { floor: -90, threshold: -45 };
  const floor = s[Math.floor(s.length * 0.1)];
  const peak = s[Math.floor(s.length * 0.98)];
  // Less than 15 dB between the noise floor and the peaks (constant noise, music,
  // compressed live audio): there is no clear silence to find by volume.
  if (peak - floor < 15) return { floor: r3(floor), peak: r3(peak), threshold: r3(floor - 6), reliable: false };
  return { floor: r3(floor), peak: r3(peak), threshold: r3(Math.min(peak - 12, Math.max(floor + 10, Math.min(peak - 20, floor + (peak - floor) * 0.35)))), reliable: true };
}

/** Onsets (energy rises) and a beat grid from the onset envelope's autocorrelation. */
export async function beats(file: string, start?: number, dur?: number) {
  const env = await envelope(file, 0.01, start, dur);
  const lin = env.db.map((d) => Math.pow(10, d / 20));
  // Onset strength: positive change of a smoothed envelope.
  const sm = lin.map((_, i) => (lin[i - 1] ?? lin[i]) * 0.25 + lin[i] * 0.5 + (lin[i + 1] ?? lin[i]) * 0.25);
  const flux = sm.map((v, i) => Math.max(0, v - (sm[i - 1] ?? v)));
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
  const onsets: number[] = [];
  const win = 5;
  for (let i = 1; i < flux.length - 1; i++) {
    let local = 0;
    for (let k = Math.max(0, i - 20); k < Math.min(flux.length, i + 20); k++) local += flux[k];
    local /= 40;
    if (flux[i] > mean * 1.5 && flux[i] > local * 1.8 && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) {
      if (!onsets.length || i * env.hop - onsets[onsets.length - 1] > win * env.hop) onsets.push(r3(i * env.hop));
    }
  }
  // Tempo by autocorrelation of the onset strength between 60 and 200 BPM.
  let bestLag = 0;
  let best = -1;
  const minLag = Math.round(60 / 200 / env.hop);
  const maxLag = Math.round(60 / 60 / env.hop);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < flux.length; i++) s += flux[i] * flux[i + lag];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  // Octave errors: autocorrelation also peaks at 2x the beat period; prefer the
  // shorter period when it is nearly as strong.
  const score = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < flux.length; i++) s += flux[i] * flux[i + lag];
    return s;
  };
  while (bestLag / 2 >= minLag && score(Math.round(bestLag / 2)) >= best * 0.7) {
    bestLag = Math.round(bestLag / 2);
    best = score(bestLag);
  }
  const period = bestLag * env.hop;
  const bpm = period > 0 ? r3(60 / period) : null;
  // Phase: the offset that lines the grid up with most onset strength.
  let phase = 0;
  let bestP = -1;
  for (let p = 0; p < bestLag; p++) {
    let s = 0;
    for (let i = p; i < flux.length; i += bestLag) s += flux[i];
    if (s > bestP) {
      bestP = s;
      phase = p;
    }
  }
  const total = env.db.length * env.hop;
  const grid: number[] = [];
  if (period > 0) for (let t = phase * env.hop; t < total; t += period) grid.push(r3(t + (start || 0)));
  return { bpm, period: r3(period), beats: grid, onsets: onsets.map((t) => r3(t + (start || 0))), duration: r3(total) };
}

/** Lag (seconds) that best aligns b to a (positive: b starts later in a). */
export async function syncOffset(a: string, b: string, maxLag = 30) {
  const rate = 100;
  const [ea, eb] = await Promise.all([envelope(a, 1 / rate), envelope(b, 1 / rate)]);
  const toLin = (d: number[]) => {
    const l = d.map((v) => Math.pow(10, v / 20));
    const m = l.reduce((x, y) => x + y, 0) / Math.max(1, l.length);
    return l.map((v) => v - m);
  };
  const A = toLin(ea.db);
  const B = toLin(eb.db);
  const L = Math.round(maxLag * rate);
  const scores = new Map<number, number>();
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = -L; lag <= L; lag++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < B.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= A.length) continue;
      sum += A[j] * B[i];
      n++;
    }
    if (n < rate) continue;
    const v = sum / n;
    scores.set(lag, v);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  // Confidence: peak over the best correlation more than 0.5 s away from it.
  let side = -Infinity;
  for (const [lag, v] of scores) if (Math.abs(lag - bestLag) > rate * 0.5 && v > side) side = v;
  // Refine to 1/8000 s around the coarse lag using raw samples.
  return { offset: r3(bestLag / rate), confidence: side > 0 ? r3(best / side) : null };
}

/** Black frames in a video range (blackdetect). */
export async function blackFrames(file: string, start?: number, dur?: number, minDur = 0.1) {
  const { stderr } = await ff(["-hide_banner", "-nostats", ...range(start, dur), "-i", file, "-an", "-vf", `blackdetect=d=${minDur}:pix_th=0.1`, "-f", "null", "-"]);
  const out: { start: number; end: number }[] = [];
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) out.push({ start: r3(Number(m[1]) + (start || 0)), end: r3(Number(m[2]) + (start || 0)) });
  return out;
}

/** Bright flashes: big jumps in mean luma between consecutive frames. */
export async function flashes(file: string, start?: number, dur?: number, jump = 0.35) {
  const { stderr } = await ff(["-hide_banner", "-nostats", ...range(start, dur), "-i", file, "-an", "-vf", "scale=64:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"]);
  const vals: { t: number; y: number }[] = [];
  const re = /pts_time:([\d.]+)[\s\S]*?YAVG=([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) vals.push({ t: Number(m[1]), y: Number(m[2]) / 255 });
  const out: number[] = [];
  for (let i = 1; i < vals.length - 1; i++) if (vals[i].y - vals[i - 1].y > jump && vals[i].y - vals[i + 1].y > jump * 0.5) out.push(r3(vals[i].t + (start || 0)));
  return out;
}

/** Peak / RMS / clipping of an audio range (astats). */
export async function audioStats(file: string, start?: number, dur?: number) {
  const { stderr } = await ff(["-hide_banner", "-nostats", ...range(start, dur), "-i", file, "-vn", "-af", "astats=measure_overall=Peak_level+RMS_level+Number_of_samples+Max_level:measure_perchannel=none", "-f", "null", "-"]);
  const num = (k: string) => {
    const m = new RegExp(k + ":\\s+(-?[\\d.]+|-inf)").exec(stderr.slice(stderr.lastIndexOf("Overall")));
    return m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : null;
  };
  const peak = num("Peak level dB");
  return { peakDb: peak, rmsDb: num("RMS level dB"), clipping: peak !== null && peak >= -0.1 };
}

/** Integrated loudness of a range (EBU R128). */
export async function loudnessOf(file: string, start?: number, dur?: number) {
  const { stderr } = await ff(["-hide_banner", "-nostats", ...range(start, dur), "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    return m ? Number(m[1]) : null;
  };
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

/** Luma / RGB statistics of an image (scopes). */
export async function frameStats(file: string) {
  const img = sharp(file).removeAlpha();
  const st = await img.stats();
  const [r, g, b] = st.channels;
  const { data, info } = await sharp(file).removeAlpha().resize({ width: 320 }).raw().toBuffer({ resolveWithObject: true });
  let lumSum = 0;
  let lo = 0;
  let hi = 0;
  let min = 255;
  let max = 0;
  const px = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    lumSum += y;
    if (y <= 2) lo++;
    if (y >= 253) hi++;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const pct = (n: number) => r3((n / px) * 100);
  return {
    luma: { mean: r3(lumSum / px / 2.55), min: r3(min / 2.55), max: r3(max / 2.55) },
    rgb: { r: r3(r.mean / 2.55), g: r3(g.mean / 2.55), b: r3(b.mean / 2.55) },
    clipping: { blacksPct: pct(lo), whitesPct: pct(hi) },
    castHint: Math.abs(r.mean - b.mean) > 12 ? (r.mean > b.mean ? "warm" : "cool") : "neutral",
  };
}

/** Container/stream facts + loudness of a delivered file. */
export async function deliveryFacts(file: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,bit_rate,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,bit_rate", "-of", "json", file], { windowsHide: true });
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s: any) => s.codec_type === "video");
  const a = (j.streams || []).find((s: any) => s.codec_type === "audio");
  const fr = v?.r_frame_rate ? v.r_frame_rate.split("/").map(Number) : null;
  const facts: any = {
    container: j.format?.format_name,
    duration: r3(Number(j.format?.duration)),
    bitrateKbps: j.format?.bit_rate ? Math.round(Number(j.format.bit_rate) / 1000) : null,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: fr ? r3(fr[0] / fr[1]) : null } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels } : null,
  };
  if (a) facts.loudness = await loudnessOf(file);
  return facts;
}

/** Stream-copy remux (e.g. drop audio). */
export async function remux(src: string, dest: string, args: string[]) {
  await ff(["-hide_banner", "-loglevel", "error", "-y", "-i", src, ...args, dest]);
  if (!fs.existsSync(dest)) throw Object.assign(new Error("FFmpeg could not write " + dest), { code: "FFMPEG_FAILED" });
  return dest;
}

export function r3(n: number) {
  return Math.round(n * 1000) / 1000;
}

/** Python + faster-whisper available? */
export async function whisperAvailable(): Promise<{ ok: boolean; python?: string; reason?: string }> {
  for (const py of [process.env.PREMIERE_MCP_PYTHON, "python", "python3", "py"].filter(Boolean) as string[]) {
    try {
      await run(py, ["-c", "import faster_whisper"], { windowsHide: true, timeout: 60_000 });
      return { ok: true, python: py };
    } catch {
      /* next */
    }
  }
  return { ok: false, reason: "faster-whisper is not installed (pip install faster-whisper)." };
}

/** Word-level transcription with faster-whisper (local). */
export async function transcribe(file: string, opts: { model?: string; language?: string; start?: number; dur?: number; scriptDir: string }) {
  const w = await whisperAvailable();
  if (!w.ok) throw Object.assign(new Error(w.reason || "No transcriber"), { code: "TRANSCRIBER_MISSING", hint: "pip install faster-whisper (Python 3.9+), or set PREMIERE_MCP_PYTHON." });
  const script = path.join(opts.scriptDir, "transcribe.py");
  const args = [script, file, "--model", opts.model || "base"];
  if (opts.language) args.push("--language", opts.language);
  if (opts.start) args.push("--start", String(opts.start));
  if (opts.dur) args.push("--duration", String(opts.dur));
  if (!fs.existsSync(file)) throw Object.assign(new Error(`File not found: ${file}`), { code: "FILE_NOT_FOUND" });
  let stdout = "";
  try {
    ({ stdout } = await run(w.python!, args, { maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
  } catch (e: any) {
    // Keep the last line of the Python error, not the whole traceback.
    const lines = String(e?.stderr || e?.message || e).trim().split(/\r?\n/).filter(Boolean);
    throw Object.assign(new Error(`Transcription failed: ${lines[lines.length - 1] || "unknown error"}`), { code: "TRANSCRIBE_FAILED", hint: "Run node dist/index.js --doctor to check faster-whisper; try model: 'base' or language." });
  }
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

export function ensureDir(d: string) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}
