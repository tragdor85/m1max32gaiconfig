#!/bin/sh
# Install/remove the global-todo loop launchd agent.
# Default cadence: every 15 min (PI_TODO_INTERVAL_S in the plist).
set -eu

LABEL="com.piagent.pi-todo-loop"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPTS="$HOME/.pi/agent/skills/global-todo/scripts"
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SCRIPTS/loop.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>PI_TODO_INTERVAL_S</key><string>900</string>
    <key>PI_TODO_MAX_RUNTIME_H</key><string>6</string>
    <key>PI_TODO_ACTIVE_WINDOW_S</key><string>120</string>
    <key>PI_TODO_SYNC</key><string>1</string>
    <key>PI_TODO_RETRY_COOLDOWN_H</key><string>1</string>
    <key>PI_TODO_MAX_RETRIES</key><string>3</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.pi/agent/todos/loop-stdout.log</string>
  <key>StandardErrorPath</key><string>$HOME/.pi/agent/todos/loop-stderr.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "installed $LABEL (first run done; see $HOME/.pi/agent/todos/loop.log)"
