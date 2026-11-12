#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { PremiereBridge, packageRoot } from "./bridge.js";
import { icons, widgetHtml, WIDGET_URI } from "./branding.js";
import { registerTools } from "./tools.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf-8")).version as string;
const EXT_NAME = "PremiereMCPPlus";

const INSTRUCTIONS = `Controls Adobe Premiere Pro through a CEP bridge.
Workflow tips:
- Start with premiere_status / get_project / get_timeline. Clip ids from get_timeline are stable node ids.
- Tracks are written like Premiere's UI: "V1", "V2", "A1" (1-based). Times are seconds.
- Build edits in bulk: place_clips accepts many clips with in/out, transform, effects and keyframes; media:"video" never touches audio tracks.
- Most clip tools take a selector ({tracks, name_regex, every_nth, ...}) so one call edits many clips.
- Saved Effect Presets can be applied with apply_effect_preset; titles can be rendered with create_title_image.
- Verify visually with export_frames (returns images / a contact sheet).
- If a call fails with PREMIERE_BUSY, a dialog is probably open in Premiere.`;

function createServer() {
  const bridge = sharedBridge();
  const server = new McpServer(
    { name: "premiere-pro-plus", title: "Premiere Pro", version: VERSION, icons: icons(), websiteUrl: "https://www.adobe.com/products/premiere.html" } as any,
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS } as any,
  );
  server.registerResource(
    "premiere-activity",
    WIDGET_URI,
    { title: "Premiere activity", description: "Inline card showing what Claude is doing in Premiere Pro", mimeType: "text/html;profile=mcp-app", _meta: { ui: { prefersBorder: false } } } as any,
    async () => ({
      contents: [{ uri: WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: widgetHtml(), _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }],
    }),
  );
  registerTools(server, bridge);
  compactToolList(server);
  return server;
}

/**
 * tools/list goes into the model's context on every turn: drop the per-tool
 * "$schema" URL and empty fields (a few KB on 70+ tools). Wraps the SDK handler.
 */
function compactToolList(server: any) {
  try {
    const low = server.server;
    low.setRequestHandler; // ensure handlers exist
    const map: Map<string, any> = low._requestHandlers;
    const orig = map?.get("tools/list");
    if (!orig) return;
    map.set("tools/list", async (...args: any[]) => {
      const r = await orig(...args);
      for (const t of r?.tools || []) {
        if (t.inputSchema) delete t.inputSchema.$schema;
        for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
      }
      return r;
    });
  } catch {
    /* SDK internals changed: keep the default list */
  }
}

let bridgeSingleton: PremiereBridge | null = null;
function sharedBridge() {
  if (!bridgeSingleton) bridgeSingleton = new PremiereBridge();
  return bridgeSingleton;
}

// ------------------------------------------------------------------ CLI
function cepTargetDir() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData/Roaming"), "Adobe/CEP/extensions", EXT_NAME);
  return path.join(os.homedir(), "Library/Application Support/Adobe/CEP/extensions", EXT_NAME);
}

function installCep() {
  const src = path.join(packageRoot(), "cep");
  const dest = cepTargetDir();
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  // Unsigned extensions need PlayerDebugMode for each CSXS runtime version.
  for (const v of [9, 10, 11, 12, 13]) {
    try {
      if (process.platform === "win32") execFileSync("reg", ["add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"], { stdio: "ignore" });
      else execFileSync("defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  console.log(`Installed CEP extension to ${dest}\nRestart Premiere Pro. The bridge auto-starts; the visible panel is under Window > Extensions > Premiere MCP Plus.`);
}

/** Claude Desktop config files (classic installer and the MSIX/Store package). */
function claudeDesktopConfigs(): string[] {
  const out: string[] = [];
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData/Roaming");
    out.push(path.join(appdata, "Claude", "claude_desktop_config.json"));
    const pk = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "Packages");
    try {
      for (const d of fs.readdirSync(pk)) if (/^Claude_/i.test(d)) out.push(path.join(pk, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
    } catch {
      /* no MSIX install */
    }
  } else if (process.platform === "darwin") {
    out.push(path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json"));
  }
  return out.filter((f) => fs.existsSync(path.dirname(f)));
}

function setup(replaceOriginal: boolean) {
  installCep();
  try { installUxp(); } catch (e: any) { console.log("UXP plugin not installed: " + e.message); }
  const entry = { command: process.execPath, args: [path.join(packageRoot(), "dist", "index.js")] };
  for (const file of claudeDesktopConfigs()) {
    let cfg: any = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf-8");
      fs.writeFileSync(`${file}.bak-${Date.now()}`, raw);
      try {
        cfg = JSON.parse(raw.replace(/^﻿/, ""));
      } catch {
        console.log(`! ${file} is not valid JSON; skipped (fix it and rerun setup).`);
        continue;
      }
    }
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers["premiere-pro-plus"] = entry;
    if (replaceOriginal && cfg.mcpServers["premiere-pro"]) delete cfg.mcpServers["premiere-pro"];
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`Registered in Claude Desktop: ${file}`);
    if (!replaceOriginal && cfg.mcpServers["premiere-pro"]) console.log("  note: the original 'premiere-pro' server is still registered. Rerun with --replace-original to remove it (a .bak copy is kept).");
  }
  // Claude Code (CLI / IDE extensions), if installed. On Windows `claude` is a
  // .cmd shim that needs a shell, so quote every argument ourselves.
  const q = (s: string) => (process.platform === "win32" ? `"${s.replace(/"/g, '""')}"` : s);
  const claude = (args: string[]) => execFileSync(process.platform === "win32" ? `claude ${args.map(q).join(" ")}` : "claude", process.platform === "win32" ? [] : args, { stdio: "ignore", shell: process.platform === "win32" });
  try {
    claude(["mcp", "remove", "--scope", "user", "premiere-pro-plus"]);
  } catch {
    /* not registered yet */
  }
  try {
    claude(["mcp", "add-json", "--scope", "user", "premiere-pro-plus", JSON.stringify({ type: "stdio", command: entry.command, args: entry.args })]);
    console.log("Registered in Claude Code (user scope).");
  } catch {
    console.log("Claude Code CLI not found; skipped (Claude Desktop is configured).");
  }
  console.log("\nDone. Restart Claude Desktop and Premiere Pro, then ask Claude: \"premiere_status\".");
}

/** UXP plugin folder and Premiere's plugin registry (sideloaded, needs UXP developer mode or a CC install). */
const UXP_ID = "com.premieremcpplus.uxp";
function uxpPaths() {
  const base = process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData/Roaming"), "Adobe/UXP") : path.join(os.homedir(), "Library/Application Support/Adobe/UXP");
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot(), "uxp", "manifest.json"), "utf-8")).version as string;
  return { base, version, dest: path.join(base, "Plugins", "External", `${UXP_ID}_${version}`), registry: path.join(base, "PluginsInfo", "v1", "premierepro.json") };
}
function installUxp() {
  const { base, version, dest, registry } = uxpPaths();
  if (!fs.existsSync(base)) {
    console.log("UXP is not set up on this machine (no Adobe/UXP folder); skipped the UXP plugin. CEP keeps working.");
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(packageRoot(), "uxp"), dest, { recursive: true });
  let reg: any = { plugins: [] };
  if (fs.existsSync(registry)) {
    const raw = fs.readFileSync(registry, "utf-8");
    fs.writeFileSync(`${registry}.bak-mcpplus`, raw);
    try { reg = JSON.parse(raw); } catch { reg = { plugins: [] }; }
  } else fs.mkdirSync(path.dirname(registry), { recursive: true });
  reg.plugins = (reg.plugins || []).filter((p: any) => p.pluginId !== UXP_ID);
  reg.plugins.push({ hostMinVersion: "26.0.0", name: "Premiere MCP Plus (UXP)", path: "$localPlugins\\External\\" + UXP_ID + "_" + version, pluginId: UXP_ID, status: "enabled", type: "uxp", versionString: version });
  fs.writeFileSync(registry, JSON.stringify(reg));
  console.log(`Installed UXP plugin to ${dest}\nRestart Premiere Pro (2026+). It connects to the MCP server on 127.0.0.1.`);
}
function uninstallUxp() {
  const { dest, registry } = uxpPaths();
  fs.rmSync(dest, { recursive: true, force: true });
  try {
    const reg = JSON.parse(fs.readFileSync(registry, "utf-8"));
    reg.plugins = (reg.plugins || []).filter((p: any) => p.pluginId !== UXP_ID);
    fs.writeFileSync(registry, JSON.stringify(reg));
  } catch { /* none */ }
  console.log("Removed " + dest);
}

function uninstallCep() {
  fs.rmSync(cepTargetDir(), { recursive: true, force: true });
  console.log("Removed " + cepTargetDir());
}

async function doctor() {
  const b = sharedBridge();
  const hb = b.heartbeat();
  const rows: { check: string; ok: boolean | null; info: string }[] = [];
  const add = (check: string, ok: boolean | null, info: string) => rows.push({ check, ok, info });
  const run = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, windowsHide: true }).trim();
    } catch {
      return null;
    }
  };
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("Node.js >= 20", nodeMajor >= 20, process.version);
  const ffv = run("ffmpeg", ["-hide_banner", "-version"]);
  add("FFmpeg (analysis, verify, auto_edit)", !!ffv, ffv ? ffv.split(/\r?\n/)[0].slice(0, 60) : "not on PATH (winget install ffmpeg / brew install ffmpeg)");
  add("ffprobe", !!run("ffprobe", ["-version"]), "");
  let py: string | null = null;
  for (const c of [process.env.PREMIERE_MCP_PYTHON, "python", "python3", "py"].filter(Boolean) as string[]) if (run(c, ["-c", "import faster_whisper"]) !== null) { py = c; break; }
  add("faster-whisper (transcribe, captions, fillers)", py ? true : null, py ? `via ${py}` : "optional: pip install faster-whisper");
  add("CEP extension", fs.existsSync(cepTargetDir()), fs.existsSync(cepTargetDir()) ? cepTargetDir() : "run --install-cep");
  add("CEP panel heartbeat", hb.alive, hb.alive ? `alive (${hb.ageMs} ms)` : `not alive (age ${hb.ageMs ?? "n/a"} ms): open Premiere`);
  try {
    const u = uxpPaths();
    const inst = fs.existsSync(u.dest);
    let reg = false;
    try { reg = JSON.parse(fs.readFileSync(u.registry, "utf-8")).plugins.some((p: any) => p.pluginId === UXP_ID); } catch { /* none */ }
    add("UXP plugin", inst && reg ? true : null, inst && reg ? u.dest : "optional: run --install-uxp and restart Premiere");
  } catch {
    add("UXP plugin", null, "UXP not set up on this machine");
  }
  const ame = process.platform === "win32" ? ["C:/Program Files/Adobe"].flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((x) => /Media Encoder/i.test(x)) : [])) : fs.existsSync("/Applications") ? fs.readdirSync("/Applications").filter((x) => /Media Encoder/i.test(x)) : [];
  add("Adobe Media Encoder (encode, proxies, AME exports)", ame.length ? true : null, ame.join(", ") || "optional");
  if (hb.alive) {
    try {
      const r: any = await b.call("ping", {}, { timeoutMs: 15000 });
      add("Premiere Pro", true, `${r.premiere} (${r.locale}), project: ${r.project?.name ?? "none"}`);
    } catch (e: any) {
      add("Premiere Pro", false, "ping failed: " + e.message);
    }
  } else add("Premiere Pro", false, "not reachable");
  console.log(`premiere-pro-mcp-plus ${VERSION}  (bridge dir ${b.dir})`);
  for (const r of rows) console.log(`${r.ok === true ? "OK  " : r.ok === null ? "--  " : "FAIL"}  ${r.check.padEnd(50)} ${r.info}`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows));
  b.uxp.dispose();
}

const argv = process.argv.slice(2);
if (argv.includes("--setup")) setup(argv.includes("--replace-original"));
else if (argv.includes("--install-cep")) installCep();
else if (argv.includes("--uninstall-cep")) uninstallCep();
else if (argv.includes("--install-uxp")) installUxp();
else if (argv.includes("--uninstall-uxp")) uninstallUxp();
else if (argv.includes("--doctor")) doctor().then(() => process.exit(0));
else if (argv.includes("--version")) console.log(VERSION);
else {
  // Bundles (.mcpb, plugins) cannot run --setup: install the Premiere side on
  // first start when asked to. stdout is the MCP channel, so log to stderr.
  if (process.env.PREMIERE_MCP_AUTO_INSTALL === "1") {
    const log = console.log;
    console.log = (...m: unknown[]) => console.error("[premiere-pro-plus]", ...m);
    try {
      if (!fs.existsSync(cepTargetDir())) installCep();
      try { if (!fs.existsSync(uxpPaths().dest)) installUxp(); } catch { /* no UXP */ }
    } catch (e: any) {
      console.error("[premiere-pro-plus] auto install failed:", e?.message);
    } finally {
      console.log = log;
    }
  }
  serveStdio(() => createServer() as any, { onerror: (e) => console.error("[premiere-pro-plus]", e) });
}

export { createServer };
