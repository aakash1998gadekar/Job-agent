#!/bin/bash
# run-agent.sh — Wrapper for launchd that handles sleep/wake scenarios
#
# macOS launchd runs missed StartCalendarInterval jobs after wake,
# but Playwright (headed) needs the display to be available.
# This script waits for the display, then runs the Node.js script.
#
# Usage: ./run-agent.sh <script.mjs> [args...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

SCRIPT="$1"
shift

LOG_PREFIX="${SCRIPT%.mjs}"

# ── Wait for display to be available (max 120 seconds) ──────────────
wait_for_display() {
    local max_wait=120
    local waited=0

    while [ $waited -lt $max_wait ]; do
        # Check if a GUI session is available
        if [ -n "${DISPLAY:-}" ] || \
           /usr/sbin/ioreg -c AppleBacklightDisplay 2>/dev/null | grep -q "AppleBacklightDisplay" || \
           /usr/bin/pgrep -q "WindowServer"; then
            return 0
        fi
        sleep 5
        waited=$((waited + 5))
    done
    return 1
}

# ── Ensure node is available ────────────────────────────────────────
NODE=""
for candidate in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "$candidate" 2>/dev/null ]; then
        NODE="$candidate"
        break
    fi
done

if [ -z "$NODE" ]; then
    echo "❌ Node.js not found" >&2
    exit 1
fi

# ── Load .env variables ────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# ── Wait for display (headed browser needs it) ─────────────────────
echo "⏳ Waiting for display..."
if ! wait_for_display; then
    echo "⚠️  Display not available after 120s. Running anyway (may fail for headed browser)."
fi

# Give system a moment to fully wake
sleep 5

# ── Run the agent ───────────────────────────────────────────────────
echo "🚀 Running $SCRIPT at $(date)"
"$NODE" "$SCRIPT_DIR/$SCRIPT" "$@"
EXIT_CODE=$?

echo "✅ $SCRIPT finished with exit code $EXIT_CODE at $(date)"
exit $EXIT_CODE
