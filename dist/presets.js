import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const TPS = 254016000000;
const INTRINSIC = new Set(["AE.ADBE Motion", "AE.ADBE Opacity"]);
export function findPresetFiles() {
    const roots = [path.join(os.homedir(), "Documents", "Adobe", "Premiere Pro")];
    const out = [];
    for (const root of roots) {
        let versions = [];
        try {
            versions = fs.readdirSync(root);
        }
        catch {
            continue;
        }
        versions.sort((a, b) => parseFloat(b) - parseFloat(a));
        for (const v of versions) {
            const vdir = path.join(root, v);
            let profiles = [];
            try {
                profiles = fs.readdirSync(vdir).filter((p) => p.startsWith("Profile-"));
            }
            catch {
                continue;
            }
            for (const p of profiles) {
                for (const name of ["Effect Presets and Custom Items.prfpset", "Effect Presets and Custom Items.prfpst"]) {
                    const f = path.join(vdir, p, name);
                    if (fs.existsSync(f))
                        out.push(f);
                }
            }
        }
    }
    return out;
}
let cache = null;
export function loadPresets(file) {
    const f = file || findPresetFiles()[0];
    if (!f)
        throw new Error("No Premiere effect preset file (Effect Presets and Custom Items.prfpset) was found under Documents/Adobe/Premiere Pro.");
    const mtime = fs.statSync(f).mtimeMs;
    if (cache && cache.file === f && cache.mtime === mtime)
        return { file: f, presets: cache.presets };
    const xml = fs.readFileSync(f, "utf-8");
    const presets = parsePresets(xml);
    cache = { file: f, mtime, presets };
    return { file: f, presets };
}
function decodeXml(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function tag(body, name) {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
    return m ? decodeXml(m[1]) : undefined;
}
export function parsePresets(xml) {
    // Index every top-level object by ObjectID.
    const objects = new Map();
    const re = /^\t<(\w+) ObjectID="(\d+)"[^>]*>([\s\S]*?)^\t<\/\1>/gm;
    let m;
    while ((m = re.exec(xml)))
        objects.set(m[2], { type: m[1], body: m[3] });
    const rootRef = /<RootBin ObjectRef="(\d+)"\/>/.exec(xml)?.[1];
    const presets = [];
    const visit = (id, parentPath) => {
        const o = objects.get(id);
        if (!o)
            return;
        const name = tag(o.body, "Name") ?? "";
        if (o.type === "BinTreeItem") {
            const here = name === "Root" && !parentPath ? "" : parentPath ? `${parentPath}/${name}` : name;
            const items = [...o.body.matchAll(/<Item Index="\d+" ObjectRef="(\d+)"\/>/g)].map((x) => x[1]);
            for (const child of items)
                visit(child, here);
        }
        else if (o.type === "TreeItem") {
            const dataRef = /<Data ObjectRef="(\d+)"\/>/.exec(o.body)?.[1];
            const data = dataRef ? objects.get(dataRef) : undefined;
            if (!data)
                return;
            const fx = parseFilterPresetItem(data.body, objects);
            if (fx.length)
                presets.push({ name, path: parentPath ? `${parentPath}/${name}` : name, effects: fx });
        }
    };
    if (rootRef)
        visit(rootRef, "");
    return presets;
}
function parseFilterPresetItem(body, objects) {
    const refs = [...body.matchAll(/<FilterPreset Index="\d+" ObjectRef="(\d+)"\/>/g)].map((x) => x[1]);
    const effects = [];
    for (const ref of refs) {
        const fp = objects.get(ref);
        if (!fp)
            continue;
        const matchName = tag(fp.body, "FilterMatchName") || "";
        const type = Number(tag(fp.body, "Type") || 0);
        const anchorIn = Number(tag(fp.body, "AnchorInPoint") || 0);
        const anchorOut = Number(tag(fp.body, "AnchorOutPoint") || 0);
        const compRef = /<Component ObjectRef="(\d+)"\/>/.exec(fp.body)?.[1];
        const comp = compRef ? objects.get(compRef) : undefined;
        if (!comp)
            continue;
        const displayName = tag(comp.body, "DisplayName") || matchName;
        const instanceName = tag(comp.body, "InstanceName");
        const kind = /Audio/.test(comp.type) ? "audio" : "video";
        const paramRefs = [...comp.body.matchAll(/<Param Index="(\d+)" ObjectRef="(\d+)"\/>/g)].map((x) => ({ index: Number(x[1]), ref: x[2] }));
        const params = [];
        for (const pr of paramRefs) {
            const p = objects.get(pr.ref);
            if (!p)
                continue;
            const pname = tag(p.body, "Name") || "";
            const timeVarying = tag(p.body, "IsTimeVarying") === "true";
            const param = { index: pr.index, name: pname };
            if (timeVarying) {
                const kf = tag(p.body, "Keyframes") || "";
                const keys = kf
                    .split(";")
                    .filter(Boolean)
                    .map((k) => {
                    const parts = k.split(",");
                    const t = Number(parts[0]);
                    const v = decodeValue(parts[1]);
                    const interp = Number(parts[2]);
                    const span = anchorOut - anchorIn;
                    return {
                        fromStart: (t - anchorIn) / TPS,
                        fromEnd: (anchorOut - t) / TPS,
                        frac: span > 0 ? (t - anchorIn) / span : undefined,
                        v,
                        interp: interp === 4 ? 4 : interp === 5 ? 5 : interp === 0 ? 0 : undefined,
                    };
                })
                    .filter((k) => k.v !== undefined);
                if (keys.length)
                    param.keys = keys;
            }
            else {
                const sk = tag(p.body, "StartKeyframe");
                if (sk) {
                    const v = decodeValue(sk.split(",")[1]);
                    if (v !== undefined)
                        param.v = v;
                }
            }
            if (param.v !== undefined || param.keys)
                params.push(param);
        }
        effects.push({
            matchName,
            displayName,
            instanceName,
            intrinsic: INTRINSIC.has(matchName),
            anchor: type === 1 ? "in" : type === 2 ? "out" : type === 0 ? "scale" : "in",
            params,
            kind,
        });
    }
    return effects;
}
function decodeValue(raw) {
    if (raw === undefined)
        return undefined;
    const s = raw.trim();
    if (s === "true")
        return true;
    if (s === "false")
        return false;
    if (/^-?\d+(\.\d*)?(e[-+]?\d+)?:-?\d+(\.\d*)?(e[-+]?\d+)?$/i.test(s)) {
        const [x, y] = s.split(":").map(Number);
        return [x, y];
    }
    // 64-bit packed colors (16 bits per channel ARGB) are too big for a double.
    if (/^\d{17,}$/.test(s))
        return undefined;
    if (/^-?\d+(\.\d*)?(e[-+]?\d+)?$/i.test(s))
        return Number(s);
    return undefined; // arbitrary/opaque data cannot be replayed by script
}
export function findPreset(presets, query) {
    const q = query.trim().toLowerCase();
    const norm = (s) => s.toLowerCase().replace(/[\s_\-]+/g, "");
    const exact = presets.filter((p) => p.path.toLowerCase() === q || p.name.toLowerCase() === q);
    if (exact.length === 1)
        return exact[0];
    if (exact.length > 1)
        return exact[exact.length - 1];
    const loose = presets.filter((p) => norm(p.name) === norm(query) || norm(p.path).endsWith(norm(query)));
    if (loose.length)
        return loose[loose.length - 1];
    const contains = presets.filter((p) => norm(p.path).includes(norm(query)));
    if (contains.length === 1)
        return contains[0];
    const sugg = contains.length ? contains : presets.filter((p) => norm(p.name).includes(norm(query).slice(0, 4)));
    throw new Error(`Preset '${query}' not found.${sugg.length ? " Did you mean: " + sugg.slice(0, 8).map((p) => p.path).join(" | ") : ""}`);
}
