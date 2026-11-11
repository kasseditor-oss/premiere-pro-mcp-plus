# Premiere Pro MCP Plus

Servidor MCP para controlar o **Adobe Premiere Pro** pelo Claude. É uma recriação
melhorada do `premiere-pro-mcp` (leancoderkavy, MIT): ponte mais rápida, menos
ferramentas porém mais poderosas, funções novas e correções de bugs.

## Instalar (um prompt)

Mande para o Claude: *"Instala esse MCP: &lt;link do repositório&gt;"*.
O Claude segue o [INSTALL.md](INSTALL.md). Manualmente:

```bash
git clone <link> premiere-pro-mcp-plus
cd premiere-pro-mcp-plus
npm install
npm run setup     # build + extensão CEP + registra no Claude Desktop e Claude Code
```

Reinicie o Claude Desktop e o Premiere Pro. Teste com `node dist/index.js --doctor`.

## O que tem de novo em relação ao original

| | Original 1.24.1 | Plus 2.0 |
|---|---|---|
| Tamanho da lista de tools (contexto do Claude) | 432 tools, 2,18 MB | 51 tools, 69 KB (~30× menor) |
| Ponte | script inteiro gerado por chamada, polling 200 ms | biblioteca carregada uma vez + JSON-RPC, `fs.watch` |
| Widget no chat (MCP Apps) e ícone | não | card do Premiere com status, resumo e prévia de frames |
| Montar timeline | 1 clipe por chamada (ou gambiarra com FCP XML) | `place_clips`: dezenas de clipes com in/out, transform, efeitos e keyframes numa chamada |
| Clipe só com vídeo | `add_to_timeline` empurrava/sobrescrevia o áudio | `media:"video"` nunca toca nas trilhas de áudio |
| Presets de efeito | impossível (precisava arrastar com computer use) | `apply_effect_preset` lê o `.prfpset` e aplica efeitos + keyframes |
| Exportar FCP XML | abria o diálogo "Translation Report" e travava | sem diálogo |
| Velocidade do clipe | recusado | `set_clip_speed` (2×, reverso) |
| Títulos | não | `create_title_image`: PNG com fonte (.ttf), contorno, sublinhado, sombra, e já coloca na timeline |
| Trocar PNG em uso | cache do Premiere / arquivo travado | `replace_media` e títulos salvam com nome novo automaticamente |
| Seletores | por clipe | `{tracks, name_regex, every_nth, at...}` em quase todas as tools |
| Efeitos em Premiere em português | nomes tinham que ser exatos | aceita nomes em inglês e traduz (Gaussian Blur, Cross Dissolve...) |
| Ver o resultado | `export_frame` 1 arquivo | `export_frames` devolve as imagens / contact sheet para o Claude ver |
| Análise de mídia | — | silêncios, cortes de cena, LUFS, probe (FFmpeg local) |
| Lote | — | `batch`: várias operações num só round-trip |

## Ferramentas

Status/projeto: `premiere_status`, `get_project`, `list_project_items`, `get_item_info`,
`import_media`, `replace_media`, `manage_bins`, `manage_project_items`, `project_file`.

Sequências: `list_sequences`, `open_sequence`, `create_sequence`, `manage_sequence`,
`sequence_tools` (subsequence, Auto Reframe, Scene Edit Detection).

Timeline: `get_timeline`, `manage_tracks`, `place_clips`, `find_clips`, `edit_clips`,
`remove_clips`, `razor`, `set_clip_speed`, `close_gaps`, `select_clips`.

Efeitos: `list_available_effects`, `get_clip_effects`, `apply_effects`, `remove_effects`,
`set_properties`, `set_transform`, `add_keyframes`, `remove_keyframes`, `copy_effects`,
`list_effect_presets`, `apply_effect_preset`, `add_transitions`.

Áudio: `set_volume`, `fade_audio`. Marcadores: `markers`, `playhead`.

Exportação: `export_frames`, `export_sequence`, `list_export_presets`, `export_interchange` (FCP XML / EDL / AAF).

Gráficos: `create_title_image`, `mogrt`, `import_captions`. Análise: `analyze_media`.

Avançado: `batch`, `run_extendscript`, `undo`.

## Testes

```bash
npm test                         # ES3 + smoke MCP
node tests/e2e-premiere.mjs      # 40 operações reais no Premiere aberto
```

## Licença

MIT.
