#!/usr/bin/env bash
# Install fanyi services as LaunchAgents:
#   - fanyi-server on THIS Mac (localhost:8787)
#   - fanyi-asr-worker on the Mac mini (192.168.50.8:8788)
#
# Usage:
#   scripts/install-services.sh install     # install & load
#   scripts/install-services.sh uninstall   # unload & remove
#   scripts/install-services.sh status      # show launchctl list state + log tails
#   scripts/install-services.sh restart     # kickstart both
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_LA="$HOME/Library/LaunchAgents/com.fanyi.server.plist"
REMOTE_HOST="wangyan@192.168.50.8"
REMOTE_LA='$HOME/Library/LaunchAgents/com.fanyi.asr.plist'
REMOTE_PLIST="$REPO_DIR/asr-worker/com.fanyi.asr.plist"

case "${1:-install}" in
  install)
    echo "[local]  server plist → $LOCAL_LA"
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$REPO_DIR/server/com.fanyi.server.plist" "$LOCAL_LA"
    launchctl unload "$LOCAL_LA" 2>/dev/null || true
    launchctl load   "$LOCAL_LA"

    echo "[mini]   copying asr plist + worker files"
    ssh "$REMOTE_HOST" 'mkdir -p ~/fanyi-asr ~/Library/LaunchAgents'
    scp "$REPO_DIR/asr-worker/worker.py"     "$REMOTE_HOST":~/fanyi-asr/worker.py >/dev/null
    scp "$REPO_DIR/asr-worker/pyproject.toml" "$REMOTE_HOST":~/fanyi-asr/pyproject.toml >/dev/null
    scp "$REMOTE_PLIST" "$REMOTE_HOST":~/Library/LaunchAgents/com.fanyi.asr.plist >/dev/null
    ssh "$REMOTE_HOST" 'eval "$(/opt/homebrew/bin/brew shellenv)"; cd ~/fanyi-asr && uv sync 2>&1 | tail -5; launchctl unload ~/Library/LaunchAgents/com.fanyi.asr.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.fanyi.asr.plist'

    echo "[check]  waiting 3s then health probes…"
    sleep 3
    curl -sS -m 5 http://127.0.0.1:8787/health || echo "server health fail"
    echo
    curl -sS -m 10 http://192.168.50.8:8788/health || echo "asr health fail"
    echo
    echo "done."
    ;;
  uninstall)
    launchctl unload "$LOCAL_LA" 2>/dev/null || true
    rm -f "$LOCAL_LA"
    ssh "$REMOTE_HOST" 'launchctl unload ~/Library/LaunchAgents/com.fanyi.asr.plist 2>/dev/null; rm -f ~/Library/LaunchAgents/com.fanyi.asr.plist'
    echo "uninstalled."
    ;;
  restart)
    launchctl kickstart -k "gui/$(id -u)/com.fanyi.server" 2>/dev/null || launchctl load "$LOCAL_LA"
    ssh "$REMOTE_HOST" 'launchctl kickstart -k gui/$(id -u)/com.fanyi.asr 2>/dev/null || launchctl load ~/Library/LaunchAgents/com.fanyi.asr.plist'
    echo "kicked."
    ;;
  status)
    echo "─── LOCAL com.fanyi.server ───"
    launchctl list | grep com.fanyi || echo "not loaded"
    echo
    echo "─── MINI com.fanyi.asr ───"
    ssh "$REMOTE_HOST" 'launchctl list | grep com.fanyi || echo "not loaded"'
    echo
    echo "─── local log tail ───"
    tail -20 /tmp/fanyi-server.log 2>/dev/null || true
    echo
    echo "─── mini log tail ───"
    ssh "$REMOTE_HOST" 'tail -20 /tmp/fanyi-asr.log 2>/dev/null || true'
    ;;
  *)
    echo "usage: $0 {install|uninstall|restart|status}" >&2
    exit 2
    ;;
esac
