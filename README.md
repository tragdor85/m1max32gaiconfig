# m1max32gaiconfig

A complete, mirrorable description of a local-first AI development environment on an
**Apple M1 Max / 32 GB** MacBook Pro: the [pi](https://github.com/earendil-works/pi)
coding agent as the hub, a local [Splash](https://github.com/paperniuk/splash)
27 B model as the brain, and a small set of extensions, MCP servers, and launchd
services around them.

Check out this repo, fill in `.env`, run `scripts/install.sh`, and you have the same
stack: pi driven by a fast local 27 B model that runs comfortably in 32 GB of
unified memory, with the same extensions, skills, and MCP integrations.

## What's documented

| Doc | Contents |
|-----|----------|
| [docs/01-system-specs.md](docs/01-system-specs.md) | Hardware, OS, and toolchain versions (what "M1 Max 32 G" means in practice). |
| [docs/02-pi.md](docs/02-pi.md) | pi source, install, version, the `~/.pi/agent` config directory map, `settings.json`, and the global SYSTEM.md and AGENTS.md. |
| [docs/03-models.md](docs/03-models.md) | Models: the three local Splash models and how pi is configured for them. |
| [docs/04-splash.md](docs/04-splash.md) | The M1/M2 Metal-kernel Splash fork, version, build, server config, `splash-serve` launcher, launchd watchdog, and day-2 operations. |
| [docs/05-extensions.md](docs/05-extensions.md) | Every pi extension and skill in use: npm packages, the local iMessage extension, the global-todo skill, and what's deliberately disabled. |
| [docs/06-mcp.md](docs/06-mcp.md) | The builtin MCP gateway, adding MCP servers to mcp.json, and how the cache works. |
| [docs/07-sanitizing-local-repos.md](docs/07-sanitizing-local-repos.md) | How the three local repos (pi-imessage, splash-serve, pi-todo) were sanitized, history-rewritten, and published, plus a reusable pre-publish checklist. |

## Vendored config

The `pi/` directory mirrors the layout of `~/.pi/agent/` with only the stable,
personal-free files:

- `pi/settings.json`, `pi/models.json` — as-is.
- `pi/SYSTEM.md` — contains `{{PI_NOTIFY_PHONE}}`; `scripts/render.sh` fills it
  from `.env`.

Generated or personal files (`sessions/`, `todos/`, `auth.json`, `models-store.json`,
`mcp-cache.json`, `mcp.json`, token files) are never committed — see
`docs/02-pi.md` for the full directory map.

## Mirroring the setup

```bash
git clone <this-repo> $CODE_DIR/m1max32gaiconfig && cd m1max32gaiconfig
cp .env.example .env       # then edit: phone, repo URLs, CODE_DIR if needed
scripts/install.sh         # installs pi, renders config, wires extensions/MCP/splash-serve
```

Every step is also documented by hand in the docs above; the script is a convenience,
not a requirement.
