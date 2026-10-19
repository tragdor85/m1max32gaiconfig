#!/usr/bin/env bash
# install.sh — apply this config repo to the current Mac (idempotent; backs up overwrites).
#
# Usage: scripts/install.sh [--env /path/to/.env] [--skip splash] [--skip imessage] [--skip todo]
#
# Order:
#   1. prereq check (macOS / git / node / npm / pi)
#   2. pi core: pi/{settings,models}.json -> ~/.pi/agent/
#   3. npm extensions: pi/npm/package.json -> ~/.pi/agent/npm/ + npm install
#   4. render.sh (SYSTEM.md, pi-imessage config, mcp.json)
#   5. pi-imessage: clone or vendor-copy the source, npm install, symlink into extensions/
#   6. global-todo: copy skill, render origin, install LaunchAgent loop
#   7. splash-serve: clone public repo (when PI_/SPLASH_ vars allow), install launcher
#   8. summary + manual follow-ups
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO/.env"
SKIP_SPLASH=0 SKIP_IMESSAGE=0 SKIP_TODO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    --skip) case "$2" in splash) SKIP_SPLASH=1;; imessage) SKIP_IMESSAGE=1;; todo) SKIP_TODO=1;; *) echo "unknown --skip: $2" >&2; exit 2;; esac; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -f "$ENV_FILE" ] || { echo "no .env (copy .env.example and fill it first)" >&2; exit 1; }

env_get() { # KEY -> value (unquoted) or empty
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"
  printf '%s' "$v"
}

say() { printf '\n== %s ==\n' "$*"; }
backup() { if [ -e "$1" ]; then cp "$1" "$1.bak-$(date +%Y%m%d-%H%M%S)"; echo "  backed up $1"; fi; }

say "1/7 prereqs"
[ "$(uname)" = "Darwin" ] || { echo "  ! not macOS — aborting"; exit 1; }
for c in git node npm; do
  command -v "$c" >/dev/null || { echo "  ! missing: $c"; exit 1; }
done
command -v pi >/dev/null || echo "  ! pi not on PATH (brew/npm global) — steps continue, but pi will not run yet"

say "2/7 pi core files"
AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$AGENT_DIR"
for f in settings.json models.json; do
  backup "$AGENT_DIR/$f"
  cp "$REPO/pi/$f" "$AGENT_DIR/$f"
  echo "  installed $f"
done

say "3/7 npm extensions"
mkdir -p "$AGENT_DIR/npm"
if ! diff -q "$REPO/pi/npm/package.json" "$AGENT_DIR/npm/package.json" >/dev/null 2>&1; then
  backup "$AGENT_DIR/npm/package.json"
  cp "$REPO/pi/npm/package.json" "$AGENT_DIR/npm/package.json"
  (cd "$AGENT_DIR/npm" && npm install --no-audit --no-fund)
  echo "  npm extensions updated"
else
  echo "  npm extensions unchanged"
fi

say "4/7 render"
"$REPO/scripts/render.sh" --env "$ENV_FILE"

if [ "$SKIP_IMESSAGE" != 1 ]; then
  say "5/7 pi-imessage"
  IM_REPO="$(env_get PI_IMESSAGE_REPO)"
  if [ -n "$IM_REPO" ]; then
    if [ ! -d "$HOME/code/pi-imessage/.git" ]; then
      git clone "$IM_REPO" "$HOME/code/pi-imessage"
    fi
    SRC="$HOME/code/pi-imessage"
  else
    # vendor copy from this repo (sanitized tests + config.example)
    mkdir -p "$HOME/code"
    rm -rf "$HOME/code/pi-imessage"
    cp -R "$REPO/pi/extensions/pi-imessage" "$HOME/code/pi-imessage"
    SRC="$HOME/code/pi-imessage"
    echo "  (no PI_IMESSAGE_REPO — used the vendored copy from this repo)"
  fi
  (cd "$SRC" && npm install --no-audit --no-fund)
  mkdir -p "$AGENT_DIR/extensions"
  rm -f "$AGENT_DIR/extensions/pi-imessage"
  ln -s "$SRC" "$AGENT_DIR/extensions/pi-imessage"
  echo "  symlinked ~/.pi/agent/extensions/pi-imessage -> $SRC"
else
  say "5/7 pi-imessage (skipped)"
fi

if [ "$SKIP_TODO" != 1 ]; then
  say "6/7 global-todo skill"
  SKILL_DST="$AGENT_DIR/skills/global-todo"
  mkdir -p "$AGENT_DIR/skills"
  TODO_ORIGIN="$(env_get PI_TODO_ORIGIN)"
  if [ -n "$TODO_ORIGIN" ]; then
    rm -rf "$SKILL_DST"
    git clone --quiet "$TODO_ORIGIN" "$SKILL_DST"
    echo "  cloned $TODO_ORIGIN (sync on)"
  else
    rm -rf "$SKILL_DST"
    cp -R "$REPO/pi/skills/global-todo" "$SKILL_DST"
    echo "  (no PI_TODO_ORIGIN — vendored copy, loop sync stays off)"
  fi
  "$SKILL_DST/install-loop.sh"
  if [ -z "$TODO_ORIGIN" ]; then
    P="$HOME/Library/LaunchAgents/com.piagent.pi-todo-loop.plist"
    if [ -f "$P" ]; then plutil -replace EnvironmentVariables.PI_TODO_SYNC -string 0 "$P"; fi
  fi
else
  say "6/7 global-todo (skipped)"
fi

if [ "$SKIP_SPLASH" != 1 ]; then
  say "7/7 splash-serve"
  SS_REPO="$(env_get SPLASH_SERVE_REPO)"
  if [ -n "$SS_REPO" ]; then
    [ -d "$HOME/code/splash-serve/.git" ] || git clone "$SS_REPO" "$HOME/code/splash-serve"
    if [ -f "$HOME/code/splash-serve/splash-serve" ]; then
      mkdir -p "$HOME/.local/bin"
      backup "$HOME/.local/bin/splash-serve"
      cp "$HOME/code/splash-serve/splash-serve" "$HOME/.local/bin/splash-serve"
      chmod +x "$HOME/.local/bin/splash-serve"
      ln -sfn "$HOME/code/splash-serve/splash-serve-homebrew" "$HOME/.local/bin/splash-serve-homebrew" 2>/dev/null || true
      echo "  installed ~/.local/bin/splash-serve (+ homebrew alias)"
    else
      echo "  ! splash-serve checkout has no splash-serve launcher — check the repo"
    fi
  else
    echo "  (no SPLASH_SERVE_REPO — skip; set it in .env to install the launcher + watchdog)"
  fi
else
  say "7/7 splash-serve (skipped)"
fi

say "done"
cat <<'NEXT'

Manual follow-ups:
  * pi: restart pi; /mcp reconnect if MCP errors appear
  * Safari: /Applications/Safari.app/Contents/MacOS/Safari --enable-automation (once)
  * Splash: see docs/04-splash.md (one-time: make build, make install per model)
  * Verify: pi -p "say ok" ; mcp action=status ; splash-serve status
NEXT
