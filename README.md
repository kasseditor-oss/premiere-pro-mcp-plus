# Premiere Pro MCP Plus

Servidor MCP para controlar o **Adobe Premiere Pro** pelo Claude (ou outro cliente MCP).
Monta timelines inteiras numa chamada, aplica efeitos, cor e mixagem de áudio, faz
legendas e edições automáticas (jump cut, vícios de fala, multicam, Shorts) e entrega
arquivos conferidos com FFmpeg. Toda escrita relê o Premiere e diz se foi verificada.

Feito para o **Premiere Pro 2026 (26.x) em diante**, incluindo o 2027. Ponte dupla: **CEP/ExtendScript** e **UXP**,
escolhida por ação conforme o que cada uma suporta.

## Instalar

Mande para o Claude: *"Instala esse MCP: https://github.com/kasseditor-oss/premiere-pro-mcp-plus"*.
O Claude segue o [INSTALL.md](INSTALL.md). Manualmente:

```bash
git clone https://github.com/kasseditor-oss/premiere-pro-mcp-plus
cd premiere-pro-mcp-plus
npm install
npm run setup     # build + extensão CEP + plugin UXP + registro no Claude Desktop e Claude Code
node dist/index.js --doctor
```

Reinicie o Claude Desktop e o Premiere Pro.

Outras formas:
- **Claude Desktop (.mcpb):** `npm run build && node scripts/build-mcpb.mjs` e abra o bundle gerado.
- **Plugin do Claude Code:** `/plugin marketplace add kasseditor-oss/premiere-pro-mcp-plus`, depois `/plugin install premiere-pro-mcp-plus@premiere-pro-mcp-plus`.
- **Cursor, Codex, VS Code:** ver [docs/CLIENTS.md](docs/CLIENTS.md).

Opcionais: **FFmpeg** (análise, verificação de entrega, edições automáticas) e
**faster-whisper** (`pip install faster-whisper`; transcrição local, legendas, remoção de vícios).
O `--doctor` diz o que está faltando.

## O que dá para fazer

75 ferramentas agrupadas por área, cada uma com um parâmetro `action` quando faz várias coisas.
A tabela completa, gerada do próprio servidor, está em [docs/TOOLS.md](docs/TOOLS.md).

| Área | Ferramentas principais |
|---|---|
| Projeto e mídia | `get_project`, `project_file`, `import_media` (arquivos, pastas, FCP XML, AAF, .prproj, comps do AE), `media` (relink por busca, proxies via AME, interpretação, LUT de entrada, pasta vigiada), `project_tools` (backup, consolidate, smart bins, organizar bins), `metadata`, `search_items`, `inspect` |
| Sequências | `create_sequence` (dimensões, .sqpreset, a partir de itens), `manage_sequence` (zero point, formato, propriedades), `sequence_tools` (nest/unnest, auto reframe, scene detection, previews), `checkpoint` (clone + diff + restore) |
| Timeline | `place_clips` (dezenas de clipes com in/out, transform, efeitos e keyframes numa chamada), `edit_clips` (move, trim, slip, slide, roll, ripple trim, duplicate, freeze frame, lift/extract, J/L, rename em lote), `ripple_delete_ranges`, `razor`, `set_clip_speed` (rampa, optical flow), `source`, `markers`, `playhead` |
| Efeitos e cor | `apply_effects`, `apply_effect_preset` (seus presets do .prfpset), `set_transform`, `add_keyframes`, `keyframe_tools`, `copy_effects` (colar atributos), `color` (Lumetri, match shot, auto balance, LUT), `stabilize`, `scopes`, `mask_fit` |
| Áudio | `audio` (pan, gain, normalizar LUFS, ducking, beats, transientes, DeNoise/DeEsser...), `set_volume`, `fade_audio` |
| Texto e legendas | `transcribe` (local, tempo por palavra), `captions` (SRT/VTT, retime, área segura por plataforma, legendas estilo Shorts com palavra destacada), `create_title_image` (templates e animação), `mogrt` (lote e receitas) |
| Entrega | `export_frames`, `review`, `export_sequence`, `deliver` (matriz por plataforma, export em lote, por marcadores, conformidade com FFmpeg), `encode` (Media Encoder), `export_interchange` (XML, EDL, AAF, OMF, projeto) |
| Automação | `auto_edit` (jump cut, vícios de fala, montagem no beat, zoom de ênfase, multicam, reframe por falante, Shorts, capítulos, mix, sincronizar áudio, conferência visual, edição por roteiro), `recipes`, `batch`, `undo`, `jobs` |

## Exemplos de prompts

- *"Monta a sequência com os clipes da pasta Cenas na ordem dos nomes, 3 s cada, com zoom de 100 para 106 em todos."*
- *"Tira os silêncios da narração em A1 com 0,15 s de folga e põe zoom alternado nos cortes. Faz um checkpoint antes."*
- *"Remove os 'é', 'tipo' e 'né' e as pausas acima de 0,8 s. Mostra o preview antes de cortar."*
- *"Deixa a voz em -16 LUFS, abaixa a música embaixo da voz e entrega o mix em -14 LUFS / -1 dBTP."*
- *"Corta os clipes da pasta B-roll no ritmo da música, a cada 2 batidas, com dissolve curto."*
- *"Com as câmeras em V1 e V2 e os microfones em A1 e A2, alterna para quem está falando, no mínimo 2 s por plano."*
- *"Faz 3 Shorts de 45 s dos melhores trechos, com legenda palavra por palavra e 'Inscreva-se' no fim, e exporta."*
- *"Gera os capítulos do YouTube pela transcrição e me dá o texto da descrição."*
- *"Sincroniza o áudio do gravador externo (D:/audio/externo.wav) com a câmera."*
- *"Confere a timeline: frames pretos, flashes, gaps, clipes offline e legendas fora da área segura do Shorts."*
- *"Monta uma sequência seguindo este roteiro: [frases]."*
- *"Roda a receita canal_padrao na sequência Episódio 12."*

## Comportamento comum

- **Envelope padrão:** toda resposta é `{ok, tool, status, data}` ou `{ok:false, tool, status:"failed", error:{code, message, hint}}`.
  - `status` vale `verified` (estado relido bate com o pedido), `committed_unverified` (o Premiere aceitou, mas não dá para conferir), `ok` (leitura), `queued` (job) ou `needs_confirmation`.
- **Seletor de clips em tudo:** id, lista de ids, ou `{tracks, name_regex, kind, selected, at, start_min, start_max, every_nth, offset, limit}`.
- **Lote em tudo:** cada ferramenta de escrita aceita muitos alvos; `batch` junta várias ferramentas numa ida ao Premiere.
- **Clips linkados juntos:** move, trim, speed, razor, remove e volume levam o áudio do vídeo (e vice-versa), salvo `include_linked: false`.
- **Estado preservado:** a sequência e o projeto ativos voltam ao que eram quando a ferramenta trabalha em outra sequência.
- **Guarda de projeto:** toda ferramenta aceita `project` (troca para esse projeto) e `expected_project_path` (falha com `PROJECT_MISMATCH` se o ativo for outro). Com vários projetos abertos, a resposta traz um aviso.
- **Checkpoints:** `checkpoint: true` nas edições grandes clona a sequência como `[checkpoint hh:mm:ss]`; `checkpoint` faz diff (adicionados, removidos, movidos, aparados, alterados) e restore.
- **Confirmação:** apagar sequência, ripple em 10+ clipes, fechar outros projetos e consolidar devolvem um preview e um `confirm_token` de uso único (`PREMIERE_MCP_CONFIRM=0` desliga).
- **Jobs:** export, análise, transcrição, estabilização, proxies e edições automáticas aceitam `async: true`; `jobs` mostra progresso, ETA e resultado.
- **Diálogos modais:** os logs conhecidos (AAF Export Log, Translation Report) são fechados sozinhos; qualquer outro diálogo vira `PREMIERE_DIALOG` com título e texto, em vez de travar.
- **Undo por chamada:** `undo` desfaz chamadas inteiras (passos do Premiere e edições DOM), com redo.
- **Permissões e packs:** perfis `inspect`, `edit`, `export`, `filesystem`, `unsafe-script` (o `run_extendscript` só existe com `unsafe-script`); packs `essential` (20 ferramentas, ~25 KB), `editing`, `audio`, `color`, `captions`, `delivery`, `full`. Ver [docs/CLIENTS.md](docs/CLIENTS.md).
- **Backends:** `premiere_status` mostra CEP e UXP, a versão e a rota de cada ação. Uma escrita que falha num backend nunca é repetida no outro.

## Desempenho

`node bench/bench.mjs` num projeto limpo, Premiere 26.5.2, Windows 11. Resultados em `bench/results/`.

| Operação | 2.0 (c92562b) | 2.0.1 (Fase 0) | 2.5 | Meta |
|---|---|---|---|---|
| place_clips, clipes simples (vídeo) | ~80 ms/clip | 58 | 38 | ≤ 40 ✓ |
| place_clips, só áudio | — | 73 | 45 | — |
| place_clips V+A com transform + keyframes | 214 ms/clip | 97 | 63 | ≤ 90 ✓ |
| apply_effects | ~85 ms/clip | 96 | 26 | ≤ 40 ✓ |
| get_timeline compacto, 500 clipes | 1,4–4,3 s | 1,05 s (400) | 495 ms (cache: 70 ms; 3 colunas: 254 ms) | ≤ 600 ms ✓ |
| premiere_status | 40–130 ms | 38 | 24 | ≤ 40 ✓ |
| tools/list, pack essential (20 ferramentas) | — | 81 KB (tudo) | 25,5 KB (24,96 KiB) | ≤ 25 KB ✓ |
| tools/list, pack full (75 ferramentas) | 2,18 MB (original) | 81 KB (51) | 95,9 KB | — |

Os tempos sobem quando há outros projetos ou abas de sequência abertos usando a mesma mídia (ex.: 63 ms/clip em vez de 38 com dois projetos abertos). Feche os outros projetos em lotes grandes.

## Comparativo honesto com o leancoderkavy/premiere-pro-mcp (v1.30)

**O que temos a mais**
- Edições automáticas que **executam** (jump cut, vícios de fala, multicam, Shorts, mix com loudness verificado, sync, paper edit), onde ele tem ferramentas `plan_*` que só devolvem um plano.
- Lote real: dezenas de clipes com in/out, transform, efeitos e keyframes numa chamada, contra um clipe por chamada.
- Speed com ripple manual e linkados em sincronia, speed ramp, slip/slide/roll.
- Transcrição local com tempo por palavra, legendas estilo Shorts e checagem de área segura.
- Verificação de toda escrita (`status`), checkpoints e diff, undo por chamada, tokens de confirmação, perfis de permissão e packs, jobs assíncronos, detector de diálogos.
- Contexto: 75 ferramentas (95 KB no pack completo, 25 KB no essential) contra ~450 + ~98 UXP.
- Presets de efeito do usuário aplicados com keyframes, títulos PNG com fonte qualquer.

**O que ainda falta**
- O backend UXP tem poucas ações próprias (status, playhead, marcadores numa transação, script). As outras seguem pelo CEP. Ele ainda não foi testado ao vivo: precisa reiniciar o Premiere depois do `--install-uxp`.
- Importar OTIO (só existe na API UXP).
- Ler as legendas de uma caption track já existente na sequência: lemos de arquivos e transcrições.
- Lumetri avançado (curvas, HSL secundário, color wheels): só básico, criativo e vinheta.
- Ler a fila interna do Media Encoder: acompanhamos só os jobs iniciados por aqui.
- Testado só no Premiere 26.5.2 no Windows (ver matriz).

## Limitações do Premiere 26.x (e o código de erro usado)

| Limitação | Código / comportamento |
|---|---|
| Work area não muda por script | `WORK_AREA_UNSUPPORTED` (use in/out) |
| Scene Edit Detection não cria nada | corte detectado com FFmpeg (`method: "ffmpeg"`) |
| Sem exportador EDL nativo | EDL CMX3600 gerado pela timeline |
| Criar Adjustment Layer | `UNSUPPORTED_IN_PREMIERE` (reaproveita um que já exista no projeto) |
| Time remapping por script | `UNSUPPORTED_IN_PREMIERE` (speed ramp por cortes) |
| Look criativo do Lumetri por arquivo | `UNSUPPORTED_IN_PREMIERE` (use LUT de entrada ou preset) |
| Poster frame, mapeamento de canais de áudio | `UNSUPPORTED_IN_PREMIERE` |
| Clip gain é somente leitura | gain feito com o efeito Amplify |
| Pan de clipe em track mono | `UNSUPPORTED_IN_PREMIERE` |
| Texto de MOGRT nativo do Premiere | não editável; use `create_title_image` |
| OTIO via ExtendScript | `UNSUPPORTED_IN_PREMIERE` |
| Proxy com layout de áudio diferente | recusado pelo Premiere; o servidor remuxa o proxy e tenta de novo |
| Fechar o último projeto aberto | pode derrubar o Premiere; os testes nunca fazem isso |

## Matriz de compatibilidade

| | Windows 11 | macOS |
|---|---|---|
| Premiere Pro 2026 (26.5.2) | testado ao vivo (todos os e2e) | não testado |
| UXP (26.x) | plugin instalado; carregamento confirmado; rotas não testadas ao vivo | não testado |

Suporte só do **2026 em diante**: versões anteriores não são alvo. O 2027 entra nos testes quando for lançado; o servidor avisa em `premiere_status` se a versão for anterior à 26.

## Testes

```bash
npm test                          # ES3 do host, sintaxe do painel, smoke MCP
node tests/make-media.mjs         # mídia sintética (fala TTS, música 120 BPM, dois ângulos...)
node tests/e2e-premiere.mjs       # base (123 testes)
node tests/e2e-bugfixes.mjs       # regressão dos bugs antigos (18)
node tests/e2e-phase1.mjs         # arquitetura (41)
node tests/e2e-phase2.mjs         # paridade, uma checagem por ação (168)
node tests/e2e-phase3.mjs         # edições automáticas (63)
node bench/bench.mjs              # desempenho
```

Os e2e criam o próprio projeto, mandam `expected_project_path` em toda chamada (nunca mexem em outro projeto aberto) e fecham o projeto no fim quando há outro aberto.

## Licença

MIT. Baseado no `premiere-pro-mcp` de leancoderkavy (MIT).
