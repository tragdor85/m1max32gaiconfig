# 01 — System specs

Everything in this environment is chosen around one constraint: a **32 GB unified-memory
Apple Silicon laptop** running a local 27 B-parameter model as the primary agent brain.
Every choice (model size, context length, KV-cache dtype, what runs as a daemon) is a
consequence of the numbers below.

## Hardware

| | |
|---|---|
| Machine | MacBook Pro (Apple M1 Max) |
| CPU | 10-core Apple M1 Max (`arm64`, 10 logical CPUs) |
| GPU | 32-core Apple GPU (Metal) — runs all model inference |
| Unified memory | 32 GB |
| Disk | ~460 GB volume |

## OS

| | |
|---|---|
| macOS | 27.2 (build 26B5101f) |
| Kernel | Darwin 27.2.0, arm64 |
| Shell | zsh 5.9 (Homebrew), iTerm 3 |
| Terminal multiplexer | tmux 3.7 (sessions: `pi`, `splash`) |
| Package managers | Homebrew, npm, uv |

## Toolchain

| Tool | Version | Source | Role |
|---|---|---|---|
| Node.js | 25.8 | Homebrew | runs pi (and its npm extensions) |
| npm | 11.11 | with Node | pi extension installation |
| Python | 3.14.4 (`python@3.14`) | Homebrew | runs the Splash server; **3.12–3.14 required by Splash** |
| uv | 0.11 | astral.sh | isolated tool envs (e.g. `applemusic-mcp`) |
| git | 2.54 | Homebrew | |
| gh | 2.94 | Homebrew | GitHub CLI |
| tmux | 3.7 | Homebrew | keeps pi and the Splash server alive in detached sessions |

macOS ships Python 3.9 (Clang/Apple) — too old for Splash — so all Python tooling here
goes through the Homebrew `python@3.14` and `uv`.

## Why these numbers matter downstream

- **32 GB unified memory** → the local model must be ≤ ~27 B at 4-bit with ≤ 80 K
  context (KV cache in int8). That's exactly what `docs/04-splash.md` configures, and
  why bigger models run only in the cloud.
- **Metal-only inference** → upstream Splash didn't support M1/M2 GPUs, hence the
  Metal-kernel fork documented in `docs/04-splash.md`.
- **Laptop, not server** → nothing runs headless forever without a watchdog
  (`docs/04-splash.md`, `docs/05-extensions.md`); services are tmux + launchd.
