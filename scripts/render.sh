#!/usr/bin/env bash
# render.sh — replace {{PLACEHOLDER}} values in the vendored templates using .env.
#
# Usage: scripts/render.sh [--env /path/to/.env] [--force]
#   --env     .env file (default: <repo>/.env)
#   --force   overwrite existing targets (default: skip targets that exist)
#
# Targets (repo file -> destination):
#   pi/SYSTEM.md                          -> ~/.pi/agent/SYSTEM.md
#   pi/extensions/pi-imessage/config.example.json -> ~/.pi/agent/pi-imessage/config.json
# (global-todo SKILL.md/README.md are rendered by install.sh after the skill copy)
#
# Note: mcp.json is live-only (no template); it is managed directly on the machine.
#
# Rules:
#   - only vars present (non-empty) in .env are substituted
#   - unresolved {{VAR}} stays literal + a warning is printed
#   - never writes a target whose .env value is empty
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO/.env"
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -f "$ENV_FILE" ] || { echo "no .env at $ENV_FILE (copy .env.example and fill it)" >&2; exit 1; }

render_one() { # $1=src $2=dst
  local src="$1" dst="$2" work
  [ -f "$src" ] || { echo "  ! missing template: $src (skipped)" >&2; return; }
  if [ -f "$dst" ] && [ "$FORCE" != 1 ]; then
    echo "  = $dst exists (use --force to re-render)"
    return
  fi
  work="$(mktemp)"
  cp "$src" "$work"
  if [ -f "$dst" ]; then
    # force-overwrite: keep the previous live file (it may carry personal state
    # the template doesn't know about, e.g. extra MCP servers)
    cp "$dst" "$dst.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  # substitute every {{KEY}} whose KEY has a non-empty .env value
  local key val
  while IFS='=' read -r key val; do
    case "$key" in ''|\#*) continue ;; esac
    key="${key%%=*}"
    val="${val%\"}"; val="${val#\"}"
    [ -n "$val" ] || continue
    # expand $HOME / ${HOME} (the adapter & consumers don't; .env values may carry them)
    # also expand $CODE_DIR / ${CODE_DIR} (default: $HOME/code) — must come after HOME expansion.
    val="$(printf '%s' "$val" | sed -e "s|\${HOME}|$HOME|g" -e "s|\$HOME|$HOME|g" -e "s|\${CODE_DIR}|$CODE_DIR|g" -e "s|\$CODE_DIR|$CODE_DIR|g")"
    # sed-safe: escape & \ / in the replacement
    val_esc="$(printf '%s' "$val" | sed -e 's/[\\&/]/\\&/g')"
    if grep -q "{{${key}}}" "$work"; then
      sed "s/{{${key}}}/$val_esc/g" "$work" > "$work.tmp" && mv "$work.tmp" "$work"
    fi
  done < <(grep -v '^#' "$ENV_FILE" | grep '=')
  # warn about leftovers
  if grep -o '{{[A-Z_]*}}' "$work" | sort -u | grep .; then
    echo "  ! $dst: unresolved placeholders above (leaving literal)" >&2
  fi
  mkdir -p "$(dirname "$dst")"
  mv "$work" "$dst"
  echo "  rendered $dst"
}

echo "rendering from $ENV_FILE"
render_one "$REPO/pi/SYSTEM.md"                       "$HOME/.pi/agent/SYSTEM.md"
render_one "$REPO/pi/extensions/pi-imessage/config.example.json" "$HOME/.pi/agent/pi-imessage/config.json"
