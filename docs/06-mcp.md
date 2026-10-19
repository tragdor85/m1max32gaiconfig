# 06 — MCP servers

pi 1.3.0 ships a **builtin MCP client** that handles server discovery, caching,
status queries, tool search/describe, and tool invocation natively. No adapter
package is needed — the agent calls MCP tools directly via the `mcp` system.

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

## Adding an MCP server

Server definitions live in **`~/.pi/agent/mcp.json`** — this file is
**not templated**; it is created and managed directly on the machine.

To add a server, create or edit `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "/path/to/binary",
      "args": ["arg1", "arg2"]
    }
  }
}
```

- `server-name` is the identifier used in tool calls (`mcp__server-name__tool`).
- `command` is the executable; `args` is the argument list.
- For HTTP-based servers, use `"transport": "http"` and a `"url"` instead:

```json
{
  "mcpServers": {
    "http-server": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

After editing `mcp.json`, restart pi or run `mcp connect` to pick up the change.
The cache (`mcp-cache.json`) rebuilds automatically when the config hash changes.

## Generated files (gitignored, never vendored)

- `~/.pi/agent/mcp-cache.json` — per-server `configHash` + tool schemas,
  rebuilt when `mcp.json` changes;
- `~/.pi/agent/mcp-onboarding.json` — setup state.

Both regenerate; the vendor tree carries neither.
