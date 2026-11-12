# Changelog

## 2.5.0 — Fase 5: testes, distribuição e documentação

- `--doctor` checa Node, FFmpeg/ffprobe, faster-whisper, CEP (instalado e respondendo), plugin UXP, Media Encoder e a versão do Premiere.
- Bundle `.mcpb` para o Claude Desktop (`scripts/build-mcpb.mjs`), plugin e marketplace do Claude Code (`.claude-plugin/`), `scripts/start.mjs` para clientes que rodam a partir do git (Cursor, Codex, VS Code; ver `docs/CLIENTS.md`).
- `PREMIERE_MCP_AUTO_INSTALL=1` instala a extensão do Premiere ao iniciar (bundles e plugins).
- `dist/` versionado: o repositório roda sem build.
- README: ferramentas e ações, comportamento comum, desempenho, comparativo com o leancoderkavy, limitações, matriz de compatibilidade e exemplos de prompts.

## 2.4.0 — Fase 4: desempenho

- `apply_effects` sem parâmetros: caminho rápido via QE (mapa da track numa passada, verificação pela contagem de componentes): 96 → 25 ms/clip.
- `get_timeline` compacto: colunas escolhidas com `fields` e cache invalidado por contador de mudanças e pelo índice de undo do Premiere.
- `tools/list` mais enxuto: seletor de clips, transform e valores compactos, anotações só quando diferem do padrão MCP, sem `$schema` por ferramenta. Pack `essential`: 25,4 KB.
- `bench/bench.mjs` com 500 clipes (falha se algum clipe der erro); resultados versionados em `bench/results/`. place_clips 38 ms/clip, V+A com transform e keyframes 63, apply_effects 26, get_timeline 500 clipes 495 ms (cache 70 ms), status 24 ms.

## 2.3.0 — Fase 3: edições automáticas que executam

- `auto_edit`: jump_cut, remove_fillers, beat_montage, emphasis_zoom, multicam, speaker_reframe, shorts, chapters, mix, sync_audio, visual_qa, paper_edit. Todas com `preview` e `checkpoint`.
- `recipes`: fluxos JSON reutilizáveis com `{{params}}`, expostos como prompts MCP e no recurso `premiere-plus://recipes`; receita pronta `canal_padrao`.

## 2.2.0 — Fase 2: paridade de capacidade

- Inspeção (`inspect`, `search_items`), metadados (`metadata`), mídia (`media`, `project_tools`), sequências (de itens, zero point, formato, nest/unnest, previews), edição (slip, slide, roll, ripple trim, duplicate, freeze frame, lift/extract, J/L, rename em lote, `ripple_delete_ranges`, speed ramp e interpolação, `source`), cor (`color`, `stabilize`, `keyframe_tools`, colar atributos, `scopes`, `mask_fit`, adjustment layer), áudio (`audio`), legendas e transcrição local (`captions`, `transcribe`), títulos com template e animação, MOGRT em lote, marcadores (update, export CSV/capítulos, import de notas), `review`, entrega (`deliver`, `encode`, OMF, projeto), navegação e playback.
- Conector UXP: o plugin carrega o código dos handlers enviado pelo servidor e se conecta a todos os servidores MCP abertos.

## 2.1.0 — Fase 1: arquitetura

- Envelope padrão `{ok, tool, status, data | error}`; `status` verified / committed_unverified / failed.
- `expected_project_path` em todas as ferramentas de projeto; aviso com vários projetos abertos.
- Jobs assíncronos (`async: true` + `jobs`), checkpoints e diff (`checkpoint`), perfis de permissão, packs de ferramentas, tokens de confirmação de uso único, `bridge_stats`.
- Plugin UXP com WebSocket só em 127.0.0.1 e token.

## 2.0.x — Fase 0

- 19 bugs e 8 melhorias do relatório de testes c92562b (clip fantasma, clips linkados, AAF sem travar, diálogos modais, undo por chamada, etc.).
