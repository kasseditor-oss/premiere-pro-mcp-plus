# Premiere Pro MCP Plus

If the user asks you to install this project, follow [INSTALL.md](INSTALL.md)
end to end (`npm install` then `npm run setup`), then run `npm test` and
`node dist/index.js --doctor`, and tell them to restart Claude Desktop and
Premiere Pro.

## Layout

- `src/` — MCP server (TypeScript, `@modelcontextprotocol/server` v2).
  - `bridge.ts` file-based JSON-RPC bridge to the CEP panel.
  - `tools.ts` tool definitions (thin wrappers over host handlers).
  - `branding.ts` server icon and the inline MCP App widget (`ui://premiere-pro-plus/activity.html`).
  - `presets.ts` parser for Premiere's `Effect Presets and Custom Items.prfpset`.
  - `titles.ts` PNG title renderer (resvg); `media.ts` FFmpeg/sharp helpers.
  - `tools2.ts` Phase 2 tools (inspect, media, color, audio, captions, delivery...); `tools3.ts` `auto_edit` and `recipes`.
  - `analysis.ts` FFmpeg analysis (envelopes, beats, sync, loudness, scopes) and the faster-whisper call; `autoedit.ts` pure planning helpers; `captions.ts` SRT/VTT and caption cards.
  - `policy.ts` permission profiles, tool packs, confirmation tokens; `jobs.ts`; `checkpoint.ts` (snapshots + diff); `uxp.ts` WebSocket server for the UXP plugin; `dialogs.ts` modal-dialog watcher.
  - Tool results use the envelope `{ok, tool, status, data|error}`; handlers return `verified: true/false` or `status`.
- `host/premiere-lib.jsx` — ExtendScript library loaded into Premiere. **Must stay ES3**:
  no `let/const`, arrow functions, or reserved words as property names (`in`, `class`...).
  `npm test` checks this with acorn `--ecma3`. ExtendScript also evaluates an
  unparenthesized chained ternary wrongly (`a ? 1 : b ? 2 : 3` returns 2 when `a`
  is true): write `a ? 1 : (b ? 2 : 3)`. `scripts/check-es3.mjs` rejects the bad form.
- `cep/` — CEP extension (panel + headless auto-start) that executes calls.
- `uxp/` — UXP loader plugin (`main.js`) and the handlers the server sends it (`handlers.js`).
- `tests/` — live e2e suites (`e2e-premiere`, `e2e-phase1..3`, `harness.mjs` adds `expected_project_path` to every call); `make-media.mjs` synthetic media.

## Rules

- Never run experiments against a project you did not create: pass `expected_project_path` (the harness does).

- Host handlers are called as `H.<name>(args)`; add new handlers there and expose them in `tools.ts`.
- Keyframe times are media time: clip in-point + offset × speed (see `keyBase`).
- `Marker.end` takes seconds, not a `Time`. `Sequence.end` is a ticks string.
- Node ids look like `000f4241` (hex), not decimal.
