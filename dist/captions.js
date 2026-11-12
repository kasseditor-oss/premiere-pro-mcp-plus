import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { escapeXml } from "./media.js";
const r3 = (n) => Math.round(n * 1000) / 1000;
function ts(t, sep) {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}
function parseTs(s) {
    const m = /(?:(\d+):)?(\d+):(\d+)[,.](\d+)/.exec(s.trim());
    if (!m)
        return NaN;
    return (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0").slice(0, 3)) / 1000);
}
/** Parse SRT or WebVTT. */
export function parseSubtitles(text) {
    const out = [];
    const blocks = text.replace(/\r/g, "").replace(/^WEBVTT[^\n]*\n/, "").split(/\n\s*\n/);
    for (const b of blocks) {
        const lines = b.split("\n").filter((l) => l.trim() !== "");
        const i = lines.findIndex((l) => l.includes("-->"));
        if (i < 0)
            continue;
        const [a, z] = lines[i].split("-->");
        const start = parseTs(a);
        const end = parseTs(z.split(" ").filter(Boolean)[0]);
        if (isNaN(start) || isNaN(end))
            continue;
        out.push({ start: r3(start), end: r3(end), text: lines.slice(i + 1).join("\n").replace(/<[^>]+>/g, "") });
    }
    return out;
}
export function toSrt(cues) {
    return cues.map((c, i) => `${i + 1}\n${ts(c.start, ",")} --> ${ts(c.end, ",")}\n${c.text}\n`).join("\n");
}
export function toVtt(cues) {
    return "WEBVTT\n\n" + cues.map((c) => `${ts(c.start, ".")} --> ${ts(c.end, ".")}\n${c.text}\n`).join("\n");
}
/** Group transcript words into caption cues (max characters, max duration, break on pauses). */
export function wordsToCues(words, maxChars = 32, maxDur = 3, pause = 0.6) {
    const out = [];
    let cur = null;
    for (const w of words) {
        const word = w.word.trim();
        if (!word)
            continue;
        const tooLong = cur && (cur.text.length + 1 + word.length > maxChars || w.end - cur.start > maxDur || w.start - cur.end > pause);
        if (!cur || tooLong) {
            if (cur)
                out.push(cur);
            cur = { start: w.start, end: w.end, text: word, words: [{ ...w, word }] };
        }
        else {
            cur.text += " " + word;
            cur.end = w.end;
            cur.words.push({ ...w, word });
        }
    }
    if (cur)
        out.push(cur);
    return out.map((c) => ({ ...c, start: r3(c.start), end: r3(c.end) }));
}
export function retime(cues, shift = 0, factor = 1, pivot = 0) {
    const f = (t) => r3(Math.max(0, pivot + (t - pivot) * factor + shift));
    return cues.map((c) => ({ ...c, start: f(c.start), end: f(c.end), words: c.words?.map((w) => ({ ...w, start: f(w.start), end: f(w.end) })) }));
}
/** Title/action-safe areas per platform (fractions of the frame), where UI covers the video. */
export const SAFE_ZONES = {
    youtube: { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05, note: "16:9 title-safe (90%), progress bar at the bottom" },
    shorts: { top: 0.14, bottom: 0.28, left: 0.06, right: 0.17, note: "9:16: title/channel at the bottom, buttons on the right" },
    reels: { top: 0.14, bottom: 0.3, left: 0.06, right: 0.17, note: "9:16: caption and buttons" },
    tiktok: { top: 0.12, bottom: 0.32, left: 0.06, right: 0.2, note: "9:16: caption, music, buttons" },
    instagram_feed: { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05, note: "4:5 feed" },
};
/** One PNG per cue (or per word when highlight is on: the spoken word gets highlight_color). */
export function renderCaptionCard(text, width, height, style, out, highlight = -1) {
    const size = style.size ?? Math.round(height * (height > width ? 0.045 : 0.06));
    const words = (style.uppercase ? text.toUpperCase() : text).split(/\s+/).filter(Boolean);
    const maxW = width * 0.8;
    const lines = [{ words: [] }];
    let lineLen = 0;
    words.forEach((w, i) => {
        const wl = (w.length + 1) * size * 0.55;
        if (lineLen + wl > maxW && lines[lines.length - 1].words.length) {
            lines.push({ words: [] });
            lineLen = 0;
        }
        lines[lines.length - 1].words.push({ w, i });
        lineLen += wl;
    });
    const fam = style.font_family || "Arial";
    const baseY = (style.y ?? 0.8) * height;
    const lh = size * 1.15;
    const y0 = baseY - (lines.length - 1) * lh;
    const stroke = style.stroke_width ?? Math.max(2, Math.round(size * 0.08));
    const parts = [];
    if (style.box) {
        const boxH = lines.length * lh + size * 0.5;
        parts.push(`<rect x="${width * 0.08}" y="${y0 - size}" width="${width * 0.84}" height="${boxH}" rx="${size * 0.25}" fill="${style.box.slice(0, 7)}" fill-opacity="${style.box.length > 7 ? parseInt(style.box.slice(7, 9), 16) / 255 : 0.6}"/>`);
    }
    lines.forEach((l, li) => {
        const spans = l.words.map(({ w, i }) => `<tspan fill="${i === highlight ? style.highlight_color || "#FFD400" : style.color || "#FFFFFF"}">${escapeXml(w)}</tspan>`).join(" ");
        parts.push(`<text x="${width / 2}" y="${y0 + li * lh}" font-family="${escapeXml(fam)}" font-size="${size}" font-weight="bold" text-anchor="middle" stroke="${style.stroke_color || "#000000"}" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke">${spans}</text>`);
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
    const r = new Resvg(svg, { font: { fontFiles: style.font_file ? [style.font_file] : [], loadSystemFonts: true, defaultFontFamily: fam }, fitTo: { mode: "original" } });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, r.render().asPng());
    // Bounds of the text block (for the safe-zone check).
    return { path: out, top: (y0 - size) / height, bottom: (y0 + (lines.length - 1) * lh + size * 0.3) / height, lines: lines.length };
}
/** Check a caption block against a platform's safe zone. */
export function safeZoneIssues(cues, platform) {
    const z = SAFE_ZONES[platform];
    if (!z)
        throw Object.assign(new Error(`Unknown platform ${platform}. Use ${Object.keys(SAFE_ZONES).join(", ")}.`), { code: "BAD_ARGS" });
    return cues.filter((c) => c.top < z.top || c.bottom > 1 - z.bottom).map((c) => ({ start: c.start, top: r3(c.top), bottom: r3(c.bottom), limit: { top: z.top, bottom: r3(1 - z.bottom) } }));
}
