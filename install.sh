#!/usr/bin/env bash
# ⚡ sparelimit Global Installer
# Installs 'sparelimit' as a permanent global command on macOS / Linux.

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BIN_NAME="sparelimit"
TARGET_DIR=""

echo ""
echo "⚡ Installing sparelimit globally..."

chmod +x "$DIR/sparelimit.mjs"

# Determine best global binary directory
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
  TARGET_DIR="$HOME/.local/bin"
elif [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
  TARGET_DIR="/usr/local/bin"
elif [ -d "$HOME/bin" ] && [[ ":$PATH:" == *":$HOME/bin:"* ]]; then
  TARGET_DIR="$HOME/bin"
else
  # Create ~/.local/bin and advise PATH
  mkdir -p "$HOME/.local/bin"
  TARGET_DIR="$HOME/.local/bin"
fi

TARGET_BIN="$TARGET_DIR/$BIN_NAME"

ln -sf "$DIR/sparelimit.mjs" "$TARGET_BIN"

echo "✓ Successfully linked $TARGET_BIN -> $DIR/sparelimit.mjs"
echo ""
echo "You can now run 'sparelimit' from any terminal window on your machine!"
echo ""
echo "Quick test:"
echo "  sparelimit             # Instant terminal HUD"
echo "  sparelimit watch       # Live background watcher with audio & desktop alerts"
echo "  sparelimit reset       # Kill doom loop and copy surgical handoff to clipboard"
echo "  sparelimit serve       # Launch live visual cockpit at http://localhost:4321"
echo "  sparelimit mcp         # Run JSON-RPC MCP server for Claude / Cursor / Antigravity"
echo ""
