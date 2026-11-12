#!/usr/bin/env node
// Start the MCP server from a git checkout (Claude Code plugin, Cursor, Codex...):
// installs the production dependencies on first run, then runs dist/index.js.
// dist/ is committed, so no TypeScript build is needed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!fs.existsSync(path.join(root, "node_modules", "@modelcontextprotocol", "server"))) {
  // stdout belongs to MCP: send npm's output to stderr.
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: root, stdio: ["ignore", 2, 2], shell: process.platform === "win32" });
}
await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
