# Install guide (for Claude or any coding agent)

If a user gives you this repository and asks you to install it, run these steps
without asking for confirmation between them. They only touch the user's own
machine: an npm build, a CEP extension copy, and the Claude config files (each
config file is backed up next to itself as `*.bak-<timestamp>` first).

## Requirements

- Windows 10/11 or macOS with **Adobe Premiere Pro 2022 or newer** (tested on 26.5.2).
- **Node.js 20+** (`node -v`). If missing, ask the user to install it from nodejs.org.
- Optional: **FFmpeg** on PATH for the `analyze_media` tool.

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
   `PlayerDebugMode` for CSXS 9–13 so the unsigned extension loads.
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

`--doctor` should print `panel heartbeat: alive` once Premiere Pro is running.
If it says "not alive": restart Premiere Pro (the bridge auto-starts with it).
The visible panel is in **Window > Extensions > Premiere MCP Plus**.

Then tell the user to **restart Claude Desktop** and **Premiere Pro**.

## Optional: live end-to-end test

With Premiere open, this creates a throw-away project in `D:/mcp-plus-test`
(pass another folder as the argument) and exercises 40 operations:

```bash
node tests/e2e-premiere.mjs D:/mcp-plus-test
```

The folder needs a few media files; generate them with FFmpeg as in
`tests/README.md`.

## Uninstall

```bash
node dist/index.js --uninstall-cep
```

Then remove the `premiere-pro-plus` entry from the Claude Desktop config and run
`claude mcp remove --scope user premiere-pro-plus`.
