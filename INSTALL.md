# Install guide (for Claude or any coding agent)

If a user gives you this repository and asks you to install it, run these steps
without asking for confirmation between them. They only touch the user's own
machine: an npm build, a CEP extension copy, and the Claude config files (each
config file is backed up next to itself as `*.bak-<timestamp>` first).

## Requirements

- Windows 10/11 (macOS untested) with **Adobe Premiere Pro 2024 or newer**. Priority and live tests: 2026 (26.x) and 2027; 2024/2025 work through CEP but are not the focus.
- **Node.js 20+** (`node -v`). If missing, ask the user to install it from nodejs.org.
- Optional: **FFmpeg** on PATH (analysis, delivery checks, automatic edits) and
  **faster-whisper** (`pip install faster-whisper`, Python 3.9+) for local transcription.
  `--doctor` reports both; the rest works without them.

## Steps

```bash
git clone <this repo url> premiere-pro-mcp-plus
cd premiere-pro-mcp-plus
npm install
npm run setup
```

`npm run setup` does all of this:

1. Builds TypeScript to `dist/`.
2. Copies the CEP extension to the user's CEP extensions folder
   (`%APPDATA%\Adobe\CEP\extensions\PremiereMCPPlus` on Windows) and enables
   `PlayerDebugMode` for CSXS 9–13 so the unsigned extension loads. Also copies
   the UXP plugin to `%APPDATA%\Adobe\UXP\Plugins\External` and registers it
   (optional; it loads after a Premiere restart).
3. Adds a `premiere-pro-plus` server to every Claude Desktop config it finds
   (classic installer and the Microsoft Store/MSIX package).
4. Registers the server in Claude Code (`claude mcp add --scope user`) if the
   `claude` CLI is installed.

To replace the older `premiere-pro` server (leancoderkavy/premiere-pro-mcp) in
Claude Desktop instead of keeping both, run:

```bash
node dist/index.js --setup --replace-original
```

## Verify

```bash
npm test                 # ES3 check of the host library + MCP smoke test
node dist/index.js --doctor
```

`--doctor` checks Node, FFmpeg, faster-whisper, the CEP extension and its
heartbeat, the UXP plugin, Media Encoder and the Premiere version. `CEP panel
heartbeat` must be OK once Premiere Pro is running.
If it says "not alive": restart Premiere Pro (the bridge auto-starts with it).
The visible panel is in **Window > Extensions > Premiere MCP Plus**.

Then tell the user to **restart Claude Desktop** and **Premiere Pro**.

## Optional: live end-to-end test

With Premiere open, this creates a throw-away project in the media folder
(pass it as the argument) and runs every operation, each checked by re-reading
Premiere. It closes its project at the end when another project is open.

```bash
node tests/make-media.mjs D:/mcp-plus-test     # synthetic media (FFmpeg + Windows speech)
node tests/e2e-premiere.mjs D:/mcp-plus-test
node tests/e2e-phase1.mjs D:/mcp-plus-test
node tests/e2e-phase2.mjs D:/mcp-plus-test
node tests/e2e-phase3.mjs D:/mcp-plus-test
node tests/e2e-v253.mjs D:/mcp-plus-test
node bench/bench.mjs D:/mcp-plus-test          # speed on a clean project
```

The folder needs a few media files; generate them with FFmpeg as in
`tests/README.md`. Close other projects in Premiere first: with several
projects open, edits are slower.

## Uninstall

```bash
node dist/index.js --uninstall-cep
node dist/index.js --uninstall-uxp
```

Then remove the `premiere-pro-plus` entry from the Claude Desktop config and run
`claude mcp remove --scope user premiere-pro-plus`.

## Other clients and bundles

Cursor, Codex, VS Code, the Claude Code plugin and the Claude Desktop `.mcpb`
bundle: see [docs/CLIENTS.md](docs/CLIENTS.md).
