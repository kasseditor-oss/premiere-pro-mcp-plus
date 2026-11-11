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
- `host/premiere-lib.jsx` — ExtendScript library loaded into Premiere. **Must stay ES3**:
  no `let/const`, arrow functions, or reserved words as property names (`in`, `class`...).
  `npm test` checks this with acorn `--ecma3`.
- `cep/` — CEP extension (panel + headless auto-start) that executes calls.

## Rules

- Host handlers are called as `H.<name>(args)`; add new handlers there and expose them in `tools.ts`.
- Keyframe times are media time: clip in-point + offset × speed (see `keyBase`).
- `Marker.end` takes seconds, not a `Time`. `Sequence.end` is a ticks string.
- Node ids look like `000f4241` (hex), not decimal.
