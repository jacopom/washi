#!/usr/bin/env bash
# ./install.sh [ROOT]
#   puts `washi` on the PATH, links the Claude Code skill and, on macOS, keeps the viewer
#   running at http://localhost:4747 as a LaunchAgent. ROOT is the folder holding your
#   projects; the viewer watches ROOT/*/washi/ (default ~/Projects).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${1:-$HOME/Projects}" && pwd)"
PY="$(command -v python3)"

for BIN in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  [[ -d "$BIN" && -w "$BIN" ]] && break
done
mkdir -p "$BIN"
ln -sf "$HERE/washi" "$BIN/washi"
echo "washi      → $BIN/washi"

mkdir -p "$HOME/.claude/skills"
ln -sfn "$HERE/skill" "$HOME/.claude/skills/washi"
echo "skill      → ~/.claude/skills/washi"

if [[ "$(uname)" == Darwin ]]; then
  LABEL=dev.washi.viewer
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$HERE/server.py</string><string>--root</string><string>$ROOT</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/washi.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/washi.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "viewer     → http://localhost:4747 (LaunchAgent $LABEL, watching $ROOT/*/washi)"
else
  echo "viewer     → run: washi serve --root $ROOT"
fi
