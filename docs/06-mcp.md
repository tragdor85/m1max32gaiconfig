# 06 — MCP servers

pi 1.3.0 ships a **builtin MCP client** that handles server discovery, caching,
status queries, tool search/describe, and tool invocation natively. No adapter
package is needed — the agent calls MCP tools directly via the `mcp` system.

## The two live servers

| Server | Transport | Endpoint | Auth | Tools | Role |
|---|---|---|---|---|---|
| `apple-music` | stdio | `applemusic-mcp serve` (a uv tool in `~/.local/bin`, reads Music.app data via `shortcuts`) | none (local) | 7 (`playlist`, `library`, `discover`, `catalog`, `config`, `queue`, +1) | Apple Music library/queue control for the agent |
| `safari-mcp` | stdio | `/usr/bin/safaridriver --mcp` (system Safari WebDriver) | none (local) | 17 (tabs, navigation, console, dialogs, JS eval, network) | Drives real Safari — web work without a cloud browser |

Total: **24 tools** across 2 servers.

## Using the built-in MCP

All MCP operations go through the `mcp` system, exposed as a gateway tool:

- `mcp({})` — show server status and tool counts
- `mcp({ server: "name" })` — list tools from a specific server
- `mcp({ search: "query" })` — search tools by name/description
- `mcp({ describe: "tool_name" })` — show tool parameters
- `mcp({ tool: "name", args: {…} })` — call a tool
- `mcp({ action: "install", url: "…" })` — install a new MCP endpoint
- `mcp({ connect: "server" })` — connect/refresh a server

When the system knows about a server, tools are namespaced `mcp__<server>__<tool>`.

## Server configuration

Both servers are local stdio binaries. Server definitions live in
**`~/.pi/agent/mcp.json`** — this file is **not templated**; it is created
and managed directly on the machine. See the note below.

## Generated files (gitignored, never vendored)

- `~/.pi/agent/mcp-cache.json` — per-server `configHash` + tool schemas,
  rebuilt when `mcp.json` changes;
- `~/.pi/agent/mcp-onboarding.json` — setup state.

Both regenerate; the vendor tree carries neither.

## One-time setup on a mirror

1. **Safari automation** (one time per Mac):
   `sudo safaridriver --enable-automation` (and trust the WebDriver in
   Security settings if prompted) — required for `safari-mcp`.
2. **Apple Music**: install the `applemusic-mcp` uv tool, grant Music.app
   access under Privacy → Automation/Files.

## Operating notes

- Add/remove a server by editing `mcp.json` directly (restart pi or reload;
  the cache rebuilds on hash change).
- **`mcp.json` is live-only** — no template or render step. Create it manually
  on each mirror by hand-writing the `mcpServers` object:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "/path/to/binary",
      "args": ["arg1"]
    }
  }
}
```

- `apple-music` and `safari-mcp` are local-only by construction — nothing in the
  mirror's `mcp.json` reaches the network. Add more servers as needed.
