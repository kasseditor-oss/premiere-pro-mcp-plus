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
| Tamanho da lista de tools (contexto do Claude) | 432 tools, 2,18 MB | 51 tools, 81 KB (~27× menor) |
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

Avançado: `batch` (aceita os nomes das ferramentas), `run_extendscript`, `undo` (desfaz e refaz por chamada).

## Comportamento comum

- **Clips linkados andam juntos.** `edit_clips` (move, trim), `remove_clips`, `razor` com `tracks`,
  `set_clip_speed`, `set_volume` e `fade_audio` também agem no áudio linkado de um clip de vídeo
  (e vice-versa). Use `include_linked: false` para mexer só no clip pedido.
- **Validação antes de editar.** `place_clips` e `edit_clips` conferem start, in/out contra a duração
  da mídia, track travada (`TRACK_LOCKED`) e efeitos antes de mexer na timeline. Se algo falha depois
  da edição, o clip criado é removido.
- **Sequência e projeto ativos preservados.** Uma ferramenta que recebe `sequence` devolve a sequência
  ativa original no fim. Todas aceitam `project` (nome ou caminho de um projeto aberto); com mais de um
  projeto aberto, `premiere_status` e `get_project` avisam.
- **Diálogos do Premiere.** Enquanto uma chamada espera, o servidor (Windows) confere se o Premiere
  abriu um diálogo. Logs informativos (AAF Export Log, Translation Report) são fechados e o texto volta
  em `dialogsClosed`; outros diálogos que ficam abertos viram o erro `PREMIERE_DIALOG` com título e texto.
- **Undo por chamada.** `undo {calls: N}` desfaz chamadas inteiras (passos do Premiere + edições de
  trim/move, que não entram no histórico do Premiere); `undo {redo: true, calls: N}` refaz.
- **Retorno compacto.** `get_timeline {compact: true}` devolve uma linha por clip
  `[id, nome, start, end, in, out]`; `get_project {compact: true}` só conta as sequências.

## Limitações do Premiere 26.x

| O quê | Comportamento | Código |
|---|---|---|
| Work area por script | ignorada pelo Premiere; use in/out | `WORK_AREA_UNSUPPORTED` |
| Scene Edit Detection | o Premiere não cria nada; o servidor detecta os cortes com FFmpeg | `method: "ffmpeg"` |
| EDL | sem exportador; o servidor gera CMX3600 a partir da timeline | — |
| Texto de MOGRT nativo do Premiere | não editável por script | aviso no retorno |
| Fechar o último projeto aberto por script | pode derrubar o Premiere; os testes não fazem isso | — |

## Testes

```bash
npm test                              # ES3 (palavras reservadas, ternário encadeado) + smoke MCP
node tests/e2e-premiere.mjs <pasta>   # 123 operações reais no Premiere aberto, conferidas relendo a timeline
node tests/e2e-bugfixes.mjs           # regressão do primeiro relatório de bugs
node bench/bench.mjs <pasta>          # velocidade num projeto limpo; resultado em bench/results/
```

Benchmark (Premiere 26.5.2, Windows 11, 100 clips, projeto limpo):

| Operação | 2.0 (c92562b) | agora |
|---|---|---|
| `place_clips` vídeo | ~80 ms/clip | 58 ms/clip |
| `place_clips` áudio | ~80 ms/clip | 73 ms/clip |
| `place_clips` V+A com transform + keyframes | 214 ms/clip | 97 ms/clip |
| `apply_effects` | ~85 ms/clip | 96 ms/clip |
| `get_timeline` compact, 400 clips | — | 1,05 s |
| `premiere_status` | 40–130 ms | 38 ms |

Os números variam com o estado do Premiere: abas de sequência abertas que usam a mesma mídia e outros
projetos abertos deixam as edições mais lentas. Para lotes de 10+ clips o `place_clips` fecha as abas
durante o lote e reabre no fim.

## Licença

MIT.
