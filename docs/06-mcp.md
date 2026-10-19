# 06 — MCP servers

pi 1.3.0 ships a **builtin MCP client**, but this machine runs its MCP through a
single extension instead: `settings.json` disables the builtin
(`"extensions": ["-builtin:mcp"]`) and the **`pi-mcp-adapter`** package
(5.3.1, installed in the agent's `npm/` registry — `docs/05-extensions.md`)
bridges the configured MCP servers into pi's extension/tool system. The adapter
reads the server list from **`~/.pi/agent/mcp.json`** and exposes each server's
tools to the agent (namespaced `mcp__<server>__<tool>`); it also surfaces one
`mcp` gateway tool for status/search/describe and for calling tools by name.

## The two live servers

| Server | Transport | Endpoint | Auth | Tools | Role |
|---|---|---|---|---|---|
| `apple-music` | stdio | `applemusic-mcp serve` (a uv tool in `~/.local/bin`, reads Music.app data via `shortcuts`) | none (local) | 7 (`playlist`, `library`, `discover`, `catalog`, `config`, `queue`, +1) | Apple Music library/queue control for the agent |
| `safari-mcp` | stdio | `/usr/bin/safaridriver --mcp` (system Safari WebDriver) | none (local) | 17 (tabs, navigation, console, dialogs, JS eval, network) | Drives real Safari — web work without a cloud browser |

Total: **24 tools** in the live tool surface.

## `mcp.json` — templated, no secrets

Vendored as the sanitized template
[`pi/mcp.json.template`](../pi/mcp.json.template). Both servers are local stdio
binaries, so the template carries **no secrets** — its two placeholders
(`{{APPLE_MUSIC_MCP_BIN}}`, `{{SAFARI_MCP_BIN}}`) are just bin paths, kept as
`{{…}}` for uniformity with the rest of the repo. `scripts/render.sh` fills them
from `.env` and writes `~/.pi/agent/mcp.json`. The adapter does **not** expand
environment variables inside `mcp.json`, which is why a render step exists rather
than `"${…}"` values in the file. Never hand a rendered `mcp.json` to git — it's
covered by the gitignore rules (next to the cache below).

## Generated files (gitignored, never vendored)

- `~/.pi/agent/mcp-cache.json` — per-server `configHash` + tool schemas,
  rebuilt when `mcp.json` changes;
- `~/.pi/agent/mcp-onboarding.json` — adapter onboarding state
  (`piBuiltinMcpHandledVersion`, setup flags).

Both regenerate; the vendor tree carries neither.

## One-time setup on a mirror

1. **Safari automation** (one time per Mac):
   `sudo safaridriver --enable-automation` (and trust the WebDriver in
   Security settings if prompted) — required for `safari-mcp`.
2. **Apple Music**: install the `applemusic-mcp` uv tool, grant Music.app
   access under Privacy → Automation/Files.

## Operating notes

- Add/remove a server by editing `mcp.json` (restart pi or reload; the cache
  rebuilds on hash change).
- The `mcp` gateway tool (`mcp({ action: "install", url: … })`, `status`,
  `search`, `describe`, `tool` calls) is how the agent discovers and drives
  servers at runtime — it's what lets a new MCP endpoint be added
  conversationally.
- `apple-music` and `safari-mcp` are local-only by construction — nothing in the
  mirror's `mcp.json` reaches the network. Add more servers to the `mcpServers`
  map as you like (restart pi or `mcp reconnect`).
