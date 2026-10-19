# 04 — Splash: the local model server

[Splash](https://github.com/incoai/splash) is Inco's local inference engine for Apple
silicon: it runs models (MLX checkpoints, GGUF, plus draft models for speculative
decoding) behind an OpenAI/Anthropic-compatible HTTP server, tuned per model family.
It's what makes "a 27 B model as the agent's brain" practical.

## Why a fork

Upstream Splash targets M3-and-newer GPUs. This machine is an **M1 Max**, so it runs a
community fork that adds what upstream lacks for older GPUs:

> **Unofficial fork: Splash on M1/M2 Macs** — upstream 1.3.2 plus a kernel policy for
> Apple7/8 GPUs and Metal kernels written for them. A community port, not an official
> Inco release. *(from the fork's README)*

| | |
|---|---|
| Fork repo | `git@github.com:paperniuk/splash.git` (public; star the original Inco repo too) |
| Version in use | **tag `1.3.2-m1.1`** = upstream 1.3.2 + the M1/M2 commit stack |
| Source branch | `apple7-m1-1.3.2` (tag is the pinned build; the machine runs detached at the tag) |
| Prebuilt | M1/M2 binaries on the fork's [releases page](https://github.com/paperniuk/splash/releases) |
| M3 and newer | **don't use the fork** — `brew install incoai/tap/splash` (official) |

Fork features that matter day-to-day (from the fork README):

- Runs everything upstream 1.3.2 loads (MLX checkpoints, GGUF incl. Ternary Bonsai `PQ2_0`, vision encoder) on its own Metal kernels.
- **Neural Engine prefill** on M1/M2: ~1.5× faster on long prompts (`--disable-ane` to keep it all on GPU).
- **Decode, 27 B MLX 4-bit on an M1 Max (`1.3.2-m1.1`)**: ~61 tok/s on a code prompt, 46–60 across code/prose (prose slower: fewer draft-token hits).

## Installation (M1/M2)

```bash
# 1. Python 3.12–3.14 (Splash requirement; system Python 3.9 won't do)
brew install python@3.14 uv

# 2. Engine. Two options:
#    a) prebuilt M1/M2 binary from the fork's releases page, or
#    b) source (what this machine runs):
git clone git@github.com:paperniuk/splash.git $CODE_DIR/splash
cd $CODE_DIR/splash
git checkout 1.3.2-m1.1            # the pinned version
make build                         # Metal engine → build/splash; uv .venv (a few minutes)

# 3. Models (OWNER/REPO[:VARIANT] — same IDs as in pi's models.json):
make install MODEL=mlx-community/Qwen3.8-27B-4bit
make install MODEL=mlx-community/Qwen3.6-35B-A3B-4bit
make install MODEL=prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0
```

`make install` runs `install/models.py`: it downloads the weights (and the
matching DFlash-2 draft where one exists) into the Hugging Face cache
(`~/.cache/huggingface/`) and records the selection as symlinks under
`<repo>/install/models/` (everything in that tree is gitignored in the engine
repo). Switching models never re-downloads. Budget a few tens of GB across the
three models plus drafts.

(For reference, on M3-and-newer the whole thing is `brew install incoai/tap/splash`.)

The `splash` CLI in the checkout wraps the engine binary — see the exact
`splash serve` invocation in the next section. `splash pi` (also `claude`,
`codex`, `opencode`) starts a coding agent pointed at a server, a handy smoke
test: `./splash pi` from the repo.

## Running it: `splash-serve` + watchdog

The raw `splash serve` command works, but this machine runs it through a small
launcher repo, `$CODE_DIR/splash-serve` (public: `https://github.com/tragdor85/splash-serve`; sanitization playbook in
`docs/07-sanitizing-local-repos.md`). It is one operational unit: launcher + watchdog.

### `splash-serve` (the launcher)

```sh
splash-serve [27B|35B|bonsai]     # 27B is the default
```

| Alias | Model |
|---|---|
| `27B` (default) | `mlx-community/Qwen3.8-27B-4bit` (+ DFlash-2 draft) |
| `35B` | `mlx-community/Qwen3.6-35B-A3B-4bit` |
| `bonsai` | `prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0` |

Fixed tuning (baked into the launcher, M1 Max 32 GB era): **80 K context, int8 KV
cache, xhigh default reasoning effort** — it execs, exactly:

```sh
$SPLASH_REPO/splash serve \
    --model "$model" \
    --max-context "${SPLASH_MAX_CONTEXT:-80000}" \
    --kv-format int8 \
    --default-reasoning-effort xhigh
```

Why 80 K: 128 K int8 KV does not fit in 32 GB next to 27 B 4-bit weights (~15 GB) —
the failures show up as `metal_execution_failed`. Other relevant `splash serve`
flags (see `splash serve --help`): `--idle-release` (default on: release the model
from RAM after 10 min idle), `--prefill-bound-ms`, `--max-cache-disk`,
`--disable-ane`.

It runs in a detached **tmux session `splash`** so it survives terminal exits; the
server binds `127.0.0.1:8000` (loopback only, no auth) and prints `Ready` when the
model is loaded. First start after a clone/build takes a few minutes; the 27 B model
load takes ~1–2 min. The engine's **idle-release** default is in play: after 10
minutes without a request the model leaves RAM and the next request pays the reload
— intended, it keeps the 32 GB free for everything else.

### The watchdog (LaunchAgent)

`watchdog/watchdog.py` (stdlib-only Python) runs as a launchd agent and watches
`http://127.0.0.1:8000/status` every 30 s:

- restarts when the engine reports unhealthy ≥ 10 min (Metal wedge → 503
  `engine_recovering`), when `/status` is unreachable while the process lives ≥ 2 min,
  or when the process dies — the last only if the watchdog has *seen it running*
  (state persisted in `watchdog/state.json`), so a deliberately stopped server stays stopped.
- anti-flap: 10 min cooldown between restarts, max 4/hour, then 6 h give-up + a
  notification.
- relaunch = type `cd $SPLASH_CWD && splash-serve <alias>` into the tmux session;
  kills the whole process tree first. Logs: `watchdog/watchdog.log`.

Install: `sh watchdog/install.sh` (copies the plist to `~/Library/LaunchAgents`,
`--remove` uninstalls); `python3 watchdog/watchdog.py --pause/--resume` to suspend
restarting. The label is set in the plist (`com.piagent.splash-watchdog` in the
generic version; `docs/07` documents the rename from this machine's personal
label).

### Day-2 operations

```sh
# health
curl -s http://127.0.0.1:8000/status | python3 -m json.tool | head

# model
curl -s http://127.0.0.1:8000/v1/models

# stop (the lock file records the live pid)
kill "$(cat "$CODE_DIR/splash/build/runtime/serve-8000.lock" | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["pid"])')"

# start / switch model
tmux send-keys -t splash 'splash-serve 35B' CRLF

# what the watchdog has done lately
tail -20 $CODE_DIR/splash-serve/watchdog/watchdog.log
```

## Why the server shape is what it is

pi (docs/02) points at `http://127.0.0.1:8000/v1`; the splash models there are the
*only* models enabled in the picker (`docs/03-models.md`). The 74 K/64 K context
windows, the 56614 output budget, and the compaction reserves in `models.json` /
`settings.json` are all sized to this server's 80 K / int8 reality — change the
context here and update the two config files together.
