#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/Users/mathewfrazier/Desktop/swarm-mcp-lab"
UI_DIR="$ROOT/apps/swarm-ui"
APP_BUNDLE="$ROOT/target/debug/bundle/macos/swarm-ui.app"
LOG_FILE="$HOME/Library/Logs/swarm-ui-latest.log"
LOCK_DIR="/tmp/swarm-ui-latest-launch.lock"

export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$(dirname "$LOG_FILE")"

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"Swarm UI Latest\"" >/dev/null 2>&1 || true
}

open_log() {
  /usr/bin/open -a Console "$LOG_FILE" >/dev/null 2>&1 || /usr/bin/open "$LOG_FILE" >/dev/null 2>&1 || true
}

build_tauri_debug() {
  cd "$UI_DIR"
  bunx tauri build --debug
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  notify "Already building the latest app."
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

exec >>"$LOG_FILE" 2>&1

fail() {
  local line="$1"
  echo "FAILED at line $line"
  notify "Build failed. Opening log."
  open_log
  exit 1
}
trap 'fail $LINENO' ERR

echo
echo "=== Swarm UI latest launch: $(date) ==="
notify "Building latest dev app..."

if ! command -v bun >/dev/null 2>&1; then
  echo "bun was not found. PATH=$PATH"
  exit 127
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo was not found. PATH=$PATH"
  exit 127
fi

cd "$ROOT"

if pgrep -x "swarm-ui" >/dev/null 2>&1; then
  echo "Stopping existing swarm-ui process."
  pkill -TERM -x "swarm-ui" >/dev/null 2>&1 || true
  sleep 1
  pkill -KILL -x "swarm-ui" >/dev/null 2>&1 || true
fi

echo "Building MCP server bundle."
bun run build

echo "Building Tauri debug app bundle."
if ! build_tauri_debug; then
  if tail -n 120 "$LOG_FILE" | grep -q "required to be available in rlib format"; then
    echo "Detected stale Rust rlib artifacts. Running full cargo clean, then retrying Tauri build once."
    cd "$ROOT"
    cargo clean
    build_tauri_debug
  else
    exit 1
  fi
fi

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "Expected app bundle was not created: $APP_BUNDLE"
  exit 1
fi

echo "Opening $APP_BUNDLE"
/usr/bin/open -n "$APP_BUNDLE"
notify "Launched latest debug bundle."
