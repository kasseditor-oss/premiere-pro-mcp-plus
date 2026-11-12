// Synthetic test media for the Phase 2/3 suites (FFmpeg + Windows speech).
// Usage: node tests/make-media.mjs [dir]   (default D:/mcp-plus-e2e)
// speech.wav    English TTS with long pauses, fillers ("um", "uh", "like") and a repeated take
// music.wav     20 s at 120 BPM (click on every beat over a soft pad)
// speakerA.wav / speakerB.wav  two voices taking turns (0-3 A, 3.5-6.5 B, 7-10 A, 10.5-13.5 B)
// angleA.mp4 / angleB.mp4      14 s, red / blue test pattern, each with its speaker's audio
// sync_ext.wav  speakerA.wav delayed by 1.25 s (an "external recorder" to sync)
// lut.cube      warm 2-point LUT;  notes.csv  client notes with timecodes
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.resolve(process.argv[2] || "D:/mcp-plus-e2e");
fs.mkdirSync(path.join(DIR, "proxies"), { recursive: true });
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcpmedia-"));

function tts(text, file, voice = "Microsoft Zira Desktop", rate = 0) {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoice('${voice}') } catch {}; $s.Rate = ${rate}; $s.SetOutputToWaveFile('${file.replace(/'/g, "''")}'); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore" });
}

// speech.wav: phrases separated by pauses of different lengths.
const phrases = [
  ["Welcome to the channel.", 1.6],
  ["Um, today we talk about editing.", 0.4],
  ["Uh, this is like the best part.", 2.0],
  ["We cut the silence automatically.", 0.3],
  ["We cut the silence automatically.", 1.2],
  ["Thanks for watching.", 0.5],
];
const parts = [];
phrases.forEach(([t, pause], i) => {
  const f = path.join(tmp, `p${i}.wav`);
  tts(t, f);
  const g = path.join(tmp, `g${i}.wav`);
  ff("-i", f, "-af", `aresample=48000,apad=pad_dur=${pause}`, "-ac", "1", g);
  parts.push(g);
});
fs.writeFileSync(path.join(tmp, "list.txt"), parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
ff("-f", "concat", "-safe", "0", "-i", path.join(tmp, "list.txt"), "-ar", "48000", "-ac", "2", path.join(DIR, "speech.wav"));

// music.wav: 120 BPM clicks over a pad.
ff("-f", "lavfi", "-i", "sine=f=220:d=20:sample_rate=48000", "-f", "lavfi", "-i", "sine=f=1200:d=20:sample_rate=48000", "-filter_complex", "[0]volume=0.15[pad];[1]volume='if(lt(mod(t,0.5),0.04),0.9,0)':eval=frame[clk];[pad][clk]amix=inputs=2:normalize=0", "-ac", "2", path.join(DIR, "music.wav"));

// Two speakers taking turns.
const turn = (text, voice, file) => {
  const f = path.join(tmp, path.basename(file));
  tts(text, f, voice, 1);
  return f;
};
const a1 = turn("Hello, I am speaker A.", "Microsoft Zira Desktop", "a1.wav");
const a2 = turn("Back to speaker A now.", "Microsoft Zira Desktop", "a2.wav");
const b1 = turn("And this is speaker B.", "Microsoft David Desktop", "b1.wav");
const b2 = turn("Speaker B again here.", "Microsoft David Desktop", "b2.wav");
const place = (clips, out) => {
  const inputs = clips.flatMap(([f]) => ["-i", f]);
  const chains = clips.map(([, t], i) => `[${i}]aresample=48000,atrim=0:2.8,adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[x${i}]`).join(";");
  ff(...inputs, "-filter_complex", `${chains};${clips.map((_, i) => `[x${i}]`).join("")}amix=inputs=${clips.length}:normalize=0,apad=whole_dur=14,atrim=0:14[o]`, "-map", "[o]", "-ac", "2", "-ar", "48000", out);
};
place([[a1, 0], [a2, 7]], path.join(DIR, "speakerA.wav"));
place([[b1, 3.5], [b2, 10.5]], path.join(DIR, "speakerB.wav"));
ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=14", "-i", path.join(DIR, "speakerA.wav"), "-vf", "colorbalance=rs=0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(DIR, "angleA.mp4"));
ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=14", "-i", path.join(DIR, "speakerB.wav"), "-vf", "colorbalance=bs=0.6,hflip", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(DIR, "angleB.mp4"));
ff("-i", path.join(DIR, "speakerA.wav"), "-af", "adelay=1250|1250", path.join(DIR, "sync_ext.wav"));

// A low-res proxy of clipB (same audio layout, as Premiere requires for proxies).
ff("-i", path.join(DIR, "clipB.mp4"), "-vf", "scale=640:-2", "-c:v", "libx264", "-c:a", "aac", path.join(DIR, "proxies", "clipB_proxy.mp4"));
// A warm LUT (2x2x2 cube) and client notes.
fs.writeFileSync(path.join(DIR, "lut.cube"), 'TITLE "warm"\nLUT_3D_SIZE 2\n0 0 0\n1 0.05 0\n0 0.95 0\n1 1 0\n0 0 0.85\n1 0.05 0.85\n0 0.95 0.85\n1 1 0.9\n');
fs.writeFileSync(path.join(DIR, "notes.csv"), "00:00:01:00,Trocar plano,cor estranha\n00:00:03:15,Cortar pausa,\n00:05,Musica mais baixa,\n");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("media written to", DIR);
