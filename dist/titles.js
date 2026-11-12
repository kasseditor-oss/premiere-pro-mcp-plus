import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { escapeXml } from "./media.js";
function familyFromFontFile(file) {
    // Read the name table (nameID 1 = family) from a TTF/OTF.
    try {
        const buf = fs.readFileSync(file);
        const numTables = buf.readUInt16BE(4);
        for (let i = 0; i < numTables; i++) {
            const rec = 12 + i * 16;
            if (buf.toString("ascii", rec, rec + 4) !== "name")
                continue;
            const off = buf.readUInt32BE(rec + 8);
            const count = buf.readUInt16BE(off + 2);
            const strOff = off + buf.readUInt16BE(off + 4);
            let fallback = null;
            for (let j = 0; j < count; j++) {
                const r = off + 6 + j * 12;
                const platform = buf.readUInt16BE(r);
                const nameId = buf.readUInt16BE(r + 6);
                const len = buf.readUInt16BE(r + 8);
                const o = buf.readUInt16BE(r + 10);
                if (nameId !== 1)
                    continue;
                const raw = buf.subarray(strOff + o, strOff + o + len);
                if (platform === 3 || platform === 0) {
                    let s = "";
                    for (let k = 0; k + 1 < raw.length; k += 2)
                        s += String.fromCharCode(raw.readUInt16BE(k));
                    return s;
                }
                fallback = raw.toString("latin1");
            }
            return fallback;
        }
    }
    catch {
        /* ignore */
    }
    return null;
}
export function renderTitle(spec) {
    const W = spec.width ?? 1920;
    const H = spec.height ?? 1080;
    const fontFiles = [];
    let family = spec.font_family || "Arial";
    if (spec.font_file) {
        if (!fs.existsSync(spec.font_file))
            throw new Error(`Font file not found: ${spec.font_file}`);
        if (!/\.(ttf|otf)$/i.test(spec.font_file))
            throw new Error("font_file must be .ttf or .otf (convert .woff/.woff2 first).");
        fontFiles.push(spec.font_file);
        family = familyFromFontFile(spec.font_file) || family;
    }
    const align = spec.align || "center";
    const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
    const x = spec.x ?? (align === "left" ? 80 : align === "right" ? W - 80 : W / 2);
    const gap = spec.line_gap ?? 10;
    const sizes = spec.lines.map((l) => l.size ?? 120);
    const blockH = sizes.reduce((a, b) => a + b, 0) + gap * (sizes.length - 1);
    let y = spec.y ?? (H - blockH) / 2 + sizes[0] * 0.8;
    const sh = spec.shadow === false ? null : { dx: 6, dy: 6, blur: 6, color: "#000000", opacity: 0.6, ...(spec.shadow || {}) };
    const defs = sh
        ? `<defs><filter id="sh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="${sh.dx}" dy="${sh.dy}" stdDeviation="${sh.blur}" flood-color="${sh.color}" flood-opacity="${sh.opacity}"/></filter></defs>`
        : "";
    const parts = [];
    spec.lines.forEach((l, i) => {
        const size = sizes[i];
        if (i > 0)
            y += size + gap;
        const ls = l.letter_spacing ? ` letter-spacing="${l.letter_spacing}"` : "";
        const stroke = l.stroke_width ? ` stroke="${l.stroke_color || "#000"}" stroke-width="${l.stroke_width}" stroke-linejoin="round" paint-order="stroke"` : "";
        parts.push(`<text x="${x}" y="${y}" font-family="${escapeXml(family)}" font-size="${size}" fill="${l.color || "#ffffff"}" text-anchor="${anchor}"${ls}${stroke}${sh ? ' filter="url(#sh)"' : ""}>${escapeXml(l.text)}</text>`);
        if (l.underline) {
            // Approximate the text width: Bebas-like display fonts are ~0.45em per glyph.
            const approx = l.text.length * size * 0.45;
            const x0 = anchor === "start" ? x : anchor === "end" ? x - approx : x - approx / 2;
            const th = l.underline.thickness ?? Math.max(4, size * 0.06);
            const off = l.underline.offset ?? size * 0.12;
            parts.push(`<rect x="${x0}" y="${y + off}" width="${approx}" height="${th}" fill="${l.underline.color || "#46c8ff"}"${sh ? ' filter="url(#sh)"' : ""}/>`);
        }
    });
    const bg = spec.background ? `<rect width="100%" height="100%" fill="${spec.background}"/>` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${bg}${parts.join("")}</svg>`;
    const r = new Resvg(svg, { font: { fontFiles, loadSystemFonts: true, defaultFontFamily: family }, fitTo: { mode: "original" } });
    const png = r.render().asPng();
    fs.mkdirSync(path.dirname(spec.output), { recursive: true });
    let out = spec.output;
    try {
        fs.writeFileSync(out, png);
    }
    catch (e) {
        // Premiere keeps stills it uses open/locked: write a new versioned name instead of failing.
        if (!["EBUSY", "EPERM", "EACCES"].includes(e.code))
            throw e;
        const ext = path.extname(out);
        out = path.join(path.dirname(out), `${path.basename(out, ext)}__v${Date.now().toString(36)}${ext}`);
        fs.writeFileSync(out, png);
    }
    return { path: out, width: W, height: H, family, renamed: out !== spec.output || undefined };
}
