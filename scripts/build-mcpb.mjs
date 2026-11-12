// Build a Claude Desktop bundle (.mcpb): dist + host + CEP/UXP + production
// node_modules + manifest.json, zipped. Native modules (sharp, resvg) make the
// bundle specific to the OS/CPU it is built on (e.g. win32-x64).
// Usage: npm run build && node scripts/build-mcpb.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mcpb-"));
for (const d of ["dist", "host", "cep", "uxp", "scripts"]) fs.cpSync(path.join(root, d), path.join(stage, d), { recursive: true });
for (const f of ["package.json", "package-lock.json", "README.md", "INSTALL.md", "LICENSE", "CHANGELOG.md"]) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(stage, f));
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--ignore-scripts=false", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });

const manifest = {
  manifest_version: "0.2",
  name: pkg.name,
  display_name: "Premiere Pro MCP Plus",
  version: pkg.version,
  description: "Control Adobe Premiere Pro: batch timeline building, effects, color, audio mix, captions, automatic edits (jump cut, fillers, multicam, shorts) and verified delivery.",
  long_description: "See README.md. Needs Premiere Pro with the CEP extension (installed automatically on first start when auto_install is on). FFmpeg and faster-whisper are optional for analysis and transcription.",
  author: { name: "kasseditor-oss" },
  repository: { type: "git", url: "https://github.com/kasseditor-oss/premiere-pro-mcp-plus" },
  license: "MIT",
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/index.js"],
      env: { PREMIERE_MCP_PROFILES: "${user_config.profiles}", PREMIERE_MCP_PACK: "${user_config.pack}", PREMIERE_MCP_AUTO_INSTALL: "${user_config.auto_install}" },
    },
  },
  user_config: {
    profiles: { type: "string", title: "Permission profiles", description: "inspect, edit, export, filesystem, unsafe-script (or all)", default: "inspect,edit,export,filesystem", required: false },
    pack: { type: "string", title: "Tool packs", description: "essential, editing, audio, color, captions, delivery or full", default: "full", required: false },
    auto_install: { type: "string", title: "Install the Premiere extension on start", description: "1 = copy the CEP/UXP extension if missing", default: "1", required: false },
  },
  compatibility: { platforms: [process.platform], runtimes: { node: ">=20" } },
};
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
const out = path.join(root, `premiere-pro-mcp-plus-${pkg.version}-${process.platform}-${process.arch}.mcpb`);
fs.rmSync(out, { force: true });
if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${out}.zip' -Force; Move-Item -Force '${out}.zip' '${out}'`], { stdio: "inherit" });
else execFileSync("zip", ["-qr", out, "."], { cwd: stage, stdio: "inherit" });
fs.rmSync(stage, { recursive: true, force: true });
console.log("bundle:", out, Math.round(fs.statSync(out).size / 1e6) + " MB");
