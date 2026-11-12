# Usar com outros clientes MCP

O servidor fala MCP por stdio. Qualquer cliente que rode um comando local funciona.
Antes, instale o lado do Premiere uma vez: `npm install && npm run setup`
(ou `node dist/index.js --install-cep`, mais `--install-uxp` para o Premiere 25.6+).

Nos exemplos, troque `C:/caminho/premiere-pro-mcp-plus` pela pasta do repositório.

## Claude Desktop

`npm run setup` registra o servidor sozinho. Também dá para instalar o bundle `.mcpb`:
rode `npm run build && node scripts/build-mcpb.mjs` e abra o arquivo gerado no Claude Desktop.

## Claude Code

Registrar o servidor:

```bash
claude mcp add --scope user premiere-pro-plus -- node C:/caminho/premiere-pro-mcp-plus/dist/index.js
```

Ou instalar como plugin, direto do GitHub:

```
/plugin marketplace add kasseditor-oss/premiere-pro-mcp-plus
/plugin install premiere-pro-mcp-plus@premiere-pro-mcp-plus
```

O plugin instala as dependências na primeira execução e a extensão do Premiere (`PREMIERE_MCP_AUTO_INSTALL=1`).

## Cursor

`~/.cursor/mcp.json` (ou `.cursor/mcp.json` no projeto):

```json
{
  "mcpServers": {
    "premiere-pro-plus": {
      "command": "node",
      "args": ["C:/caminho/premiere-pro-mcp-plus/scripts/start.mjs"],
      "env": { "PREMIERE_MCP_PACK": "essential,editing" }
    }
  }
}
```

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.premiere-pro-plus]
command = "node"
args = ["C:/caminho/premiere-pro-mcp-plus/scripts/start.mjs"]
env = { PREMIERE_MCP_PACK = "essential,editing" }
```

## VS Code (GitHub Copilot, modo agente)

`.vscode/mcp.json` no workspace, ou o comando *MCP: Add Server*:

```json
{
  "servers": {
    "premiere-pro-plus": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/caminho/premiere-pro-mcp-plus/scripts/start.mjs"]
    }
  }
}
```

## Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `PREMIERE_MCP_PROFILES` | Perfis de permissão: `inspect`, `edit`, `export`, `filesystem`, `unsafe-script`, ou `all`. Padrão: todos menos `unsafe-script` (sem `run_extendscript`). |
| `PREMIERE_MCP_PACK` | Packs de ferramentas que o modelo vê: `essential` (20 ferramentas, ~25 KB), `editing`, `audio`, `color`, `captions`, `delivery`, `full` (padrão). Pode combinar: `essential,audio`. |
| `PREMIERE_MCP_CONFIRM` | `0` desliga os tokens de confirmação das operações destrutivas grandes. |
| `PREMIERE_MCP_UXP` | `0` desliga o backend UXP. `PREMIERE_MCP_UXP_PORT` fixa a porta (padrão: uma porta livre). |
| `PREMIERE_MCP_PREFER_UXP` | `0` faz tudo ir pelo CEP mesmo com o UXP conectado. |
| `PREMIERE_MCP_PYTHON` | Python com faster-whisper (transcrição). `PREMIERE_MCP_WHISPER_DEVICE=cuda` usa a GPU. |
| `PREMIERE_MCP_PLUS_DIR` | Pasta da ponte de arquivos (padrão: `%TEMP%/premiere-mcp-plus`). |
| `PREMIERE_MCP_AUTO_INSTALL` | `1` instala a extensão CEP/UXP ao iniciar, se faltar. |
