# Changelog

## 2.5.3 — correções do relatório de testes da 2.5.2

- `auto_edit jump_cut`: com ruído constante (menos de 15 dB entre o piso e os picos) o threshold automático não corta nada e avisa; antes cortava a sequência inteira. Cortes acima de `max_cut` (padrão 40% do material) pedem `confirm_token`. O preview traz `share` e `detail` (cada trecho com o motivo).
- `auto_edit remove_fillers`: lista de vícios por idioma, comparando com acento ("é" ≠ "e"); "e", "um" e outras palavras funcionais nunca são vício; "é" e "né" só contam isolados por pausa. Pausas só são cortadas quando o áudio está quieto e têm no máximo `max_gap` (padrão 3 s); as outras voltam em `pausesNotCut` com aviso.
- `edit_clips freeze_frame`: `at` é tempo da sequência e precisa cair dentro do clip (senão `BAD_ARGS`); novo `offset` (segundos dentro do clip). O resto do clip depois do congelamento não é mais sobrescrito pelo still.
- Mídia que o Premiere não decodifica: o diálogo "File Import Failure" fecha sozinho e `import_media` avisa; `get_item_info` avisa vídeo sem frame rate; `place_clips` devolve `UNSUPPORTED_MEDIA`.
- `auto_edit mix` com `folder` (ou `export`) grava o WAV medido e devolve `file`.
- Escritas sem `clips` (`color`, `audio`, `stabilize`) dão `BAD_ARGS` em vez de agir em todos os clips.
- `audio`: `mute`/`unmute` com `tracks` e sem `clips` agem nas tracks; nova ação `unsolo`.
- `run_extendscript` aceita `backend: "uxp"` (JavaScript no plugin UXP).
- `stabilize` só diz que a análise terminou depois de vê-la rodando; senão `committed_unverified` com nota.
- `transcribe`: `FILE_NOT_FOUND` antes de chamar o Python; erros do Python viram uma linha (`TRANSCRIBE_FAILED`).
- `sync_audio` usa a primeira track de áudio livre.
- `captions edit` diz que o transcript não muda e que o resultado é o arquivo em `path`.
- `create_title_image` avisa quando a fonte não está instalada.
- `list_export_presets` mostra `container` (mp4, mov...) e, em buscas H.264/HEVC, lista os que gravam .mp4 primeiro.
- `jobs` gravados em disco: outro processo do servidor (depois de reiniciar o Claude) ainda vê o resultado; jobs interrompidos aparecem como `lost`.
- Receitas: passo pulado diz o motivo; parâmetros desconhecidos geram aviso; passo que pede confirmação para a receita com nota.
- Cards de legenda (`captions burn_style`) e títulos: só as fontes da família são carregadas, 459 → 53 ms por card.
- Testes: `tests/unit.mjs` (no `npm test`) e `tests/e2e-v253.mjs` (ao vivo, inclui confirmação com o padrão ligado).

## 2.5.2

- Correção do 2.5.1: o 2024 e o 2025 continuam funcionando pelo CEP (UXP a partir do 25.6). A prioridade de desenvolvimento e testes é o 2026 e o 2027; `premiere_status` mostra `versionNote` abaixo da 26.

## 2.5.1

- Alvo: Premiere Pro 2026 (26.x) em diante, incluindo o 2027. Versões anteriores deixam de ser suportadas; `premiere_status` avisa (`versionWarning`). UXP com `minVersion` 26.0.

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
