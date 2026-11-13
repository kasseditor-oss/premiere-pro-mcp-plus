import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { escapeXml } from "./media.js";

/**
 * Renders a transparent PNG title (custom font file, fill, stroke, shadow,
 * underline, multi-line). Premiere's scripting API cannot create text layers,
 * so the original MCP left this to external scripts.
 */
export interface TitleLine {
  text: string;
  size?: number;
  color?: string;
  stroke_color?: string;
  stroke_width?: number;
  letter_spacing?: number;
  underline?: { color?: string; thickness?: number; offset?: number };
}
export interface TitleSpec {
  lines: TitleLine[];
  width?: number;
  height?: number;
  font_file?: string;
  font_family?: string;
  align?: "left" | "center" | "right";
  x?: number; // anchor in px (default: center / margin)
  y?: number; // baseline of first line
  line_gap?: number;
  shadow?: { dx?: number; dy?: number; blur?: number; color?: string; opacity?: number } | false;
  background?: string; // optional solid background, default transparent
  output: string;
}

function familyFromFontFile(file: string): string | null {
  // Read the name table (nameID 1 = family) from a TTF/OTF.
  try {
    const buf = fs.readFileSync(file);
    const numTables = buf.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (buf.toString("ascii", rec, rec + 4) !== "name") continue;
      const off = buf.readUInt32BE(rec + 8);
      const count = buf.readUInt16BE(off + 2);
      const strOff = off + buf.readUInt16BE(off + 4);
      let fallback: string | null = null;
      for (let j = 0; j < count; j++) {
        const r = off + 6 + j * 12;
        const platform = buf.readUInt16BE(r);
        const nameId = buf.readUInt16BE(r + 6);
        const len = buf.readUInt16BE(r + 8);
        const o = buf.readUInt16BE(r + 10);
        if (nameId !== 1) continue;
        const raw = buf.subarray(strOff + o, strOff + o + len);
        if (platform === 3 || platform === 0) {
          let s = "";
          for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
          return s;
        }
        fallback = raw.toString("latin1");
      }
      return fallback;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Family names (nameID 1) of a font file, reading only the table directory and the name table. */
function familiesOf(file: string): string[] {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const read = (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, pos);
      return b;
    };
    const head = read(0, 12);
    const starts = head.toString("ascii", 0, 4) === "ttcf" ? [read(12, 4).readUInt32BE(0)] : [0];
    const out: string[] = [];
    for (const base of starts) {
      const n = read(base + 4, 2).readUInt16BE(0);
      const dir = read(base + 12, n * 16);
      for (let i = 0; i < n; i++) {
        if (dir.toString("ascii", i * 16, i * 16 + 4) !== "name") continue;
        const tbl = read(dir.readUInt32BE(i * 16 + 8), dir.readUInt32BE(i * 16 + 12));
        const count = tbl.readUInt16BE(2);
        const strOff = tbl.readUInt16BE(4);
        for (let j = 0; j < count; j++) {
          const r = 6 + j * 12;
          const id = tbl.readUInt16BE(r + 6);
          if (id !== 1 && id !== 16) continue;
          const platform = tbl.readUInt16BE(r);
          const raw = tbl.subarray(strOff + tbl.readUInt16BE(r + 10), strOff + tbl.readUInt16BE(r + 10) + tbl.readUInt16BE(r + 8));
          let s = "";
          if (platform === 3 || platform === 0) for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
          else s = raw.toString("latin1");
          if (s) out.push(s);
        }
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

let systemFamilyCache: Set<string> | null = null;
const familyFiles = new Map<string, string[]>();
/** Lowercased family names of the installed fonts (scanned once). */
export function systemFamilies(): Set<string> {
  if (systemFamilyCache) return systemFamilyCache;
  const dirs =
    process.platform === "win32"
      ? [path.join(process.env.WINDIR || "C:\\Windows", "Fonts"), path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Windows", "Fonts")]
      : ["/Library/Fonts", "/System/Library/Fonts", path.join(process.env.HOME || "", "Library", "Fonts"), "/usr/share/fonts", path.join(process.env.HOME || "", ".fonts")];
  const set = new Set<string>();
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names)
      if (/\.(ttf|otf|ttc)$/i.test(n))
        for (const f of familiesOf(path.join(d, n))) {
          const k = f.toLowerCase();
          set.add(k);
          const list = familyFiles.get(k) || [];
          if (!list.includes(path.join(d, n))) list.push(path.join(d, n));
          familyFiles.set(k, list);
        }
  }
  systemFamilyCache = set;
  return set;
}

/**
 * resvg font options. Loading every system font costs ~0.4 s per render, so when
 * the family is installed only its files (plus Arial as fallback) are loaded.
 */
export function fontOptions(family: string, extraFiles: string[] = []) {
  systemFamilies();
  const own = familyFiles.get(family.toLowerCase());
  if (!own?.length) return { fontFiles: extraFiles, loadSystemFonts: true, defaultFontFamily: family };
  const files = [...extraFiles, ...own, ...(familyFiles.get("arial") || []), ...(familyFiles.get("segoe ui emoji") || [])];
  return { fontFiles: [...new Set(files)], loadSystemFonts: false, defaultFontFamily: family };
}

export function renderTitle(spec: TitleSpec): { path: string; width: number; height: number; family: string; renamed?: boolean; warning?: string } {
  const W = spec.width ?? 1920;
  const H = spec.height ?? 1080;
  const fontFiles: string[] = [];
  let family = spec.font_family || "Arial";
  let warning: string | undefined;
  if (spec.font_file) {
    if (!fs.existsSync(spec.font_file)) throw new Error(`Font file not found: ${spec.font_file}`);
    if (!/\.(ttf|otf)$/i.test(spec.font_file)) throw new Error("font_file must be .ttf or .otf (convert .woff/.woff2 first).");
    fontFiles.push(spec.font_file);
    family = familyFromFontFile(spec.font_file) || family;
  } else if (spec.font_family && !/^(serif|sans-serif|monospace|cursive|fantasy)$/i.test(spec.font_family)) {
    const fams = systemFamilies();
    if (fams.size && !fams.has(spec.font_family.toLowerCase())) {
      warning = `Font '${spec.font_family}' is not installed; rendered with Arial. Pass font_file (.ttf/.otf) or an installed family.`;
      family = "Arial";
    }
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
  const parts: string[] = [];
  spec.lines.forEach((l, i) => {
    const size = sizes[i];
    if (i > 0) y += size + gap;
    const ls = l.letter_spacing ? ` letter-spacing="${l.letter_spacing}"` : "";
    const stroke = l.stroke_width ? ` stroke="${l.stroke_color || "#000"}" stroke-width="${l.stroke_width}" stroke-linejoin="round" paint-order="stroke"` : "";
    parts.push(
      `<text x="${x}" y="${y}" font-family="${escapeXml(family)}" font-size="${size}" fill="${l.color || "#ffffff"}" text-anchor="${anchor}"${ls}${stroke}${sh ? ' filter="url(#sh)"' : ""}>${escapeXml(l.text)}</text>`,
    );
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
  const r = new Resvg(svg, { font: spec.font_file ? { fontFiles, loadSystemFonts: true, defaultFontFamily: family } : fontOptions(family), fitTo: { mode: "original" } });
  const png = r.render().asPng();
  fs.mkdirSync(path.dirname(spec.output), { recursive: true });
  let out = spec.output;
  try {
    fs.writeFileSync(out, png);
  } catch (e: any) {
    // Premiere keeps stills it uses open/locked: write a new versioned name instead of failing.
    if (!["EBUSY", "EPERM", "EACCES"].includes(e.code)) throw e;
    const ext = path.extname(out);
    out = path.join(path.dirname(out), `${path.basename(out, ext)}__v${Date.now().toString(36)}${ext}`);
    fs.writeFileSync(out, png);
  }
  return { path: out, width: W, height: H, family, renamed: out !== spec.output || undefined, warning };
}
