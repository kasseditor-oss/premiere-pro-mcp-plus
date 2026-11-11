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
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS } as any,
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
  return server;
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

function uninstallCep() {
  fs.rmSync(cepTargetDir(), { recursive: true, force: true });
  console.log("Removed " + cepTargetDir());
}

async function doctor() {
  const b = sharedBridge();
  const hb = b.heartbeat();
  console.log(`premiere-pro-mcp-plus ${VERSION}`);
  console.log(`bridge dir: ${b.dir}`);
  console.log(`CEP extension: ${fs.existsSync(cepTargetDir()) ? "installed at " + cepTargetDir() : "NOT installed (run --install-cep)"}`);
  console.log(`panel heartbeat: ${hb.alive ? "alive" : "not alive"} (age ${hb.ageMs ?? "n/a"} ms)`);
  if (hb.alive) {
    try {
      const r = await b.call("ping", {}, { timeoutMs: 15000 });
      console.log("ping:", JSON.stringify(r));
    } catch (e: any) {
      console.log("ping failed:", e.message);
    }
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--setup")) setup(argv.includes("--replace-original"));
else if (argv.includes("--install-cep")) installCep();
else if (argv.includes("--uninstall-cep")) uninstallCep();
else if (argv.includes("--doctor")) doctor().then(() => process.exit(0));
else if (argv.includes("--version")) console.log(VERSION);
else {
  serveStdio(() => createServer() as any, { onerror: (e) => console.error("[premiere-pro-plus]", e) });
}

export { createServer };
