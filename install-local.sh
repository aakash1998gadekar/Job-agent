#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Install Career-Ops job agents as macOS LaunchAgents
# Runs daily at 8:00 AM (profile update) and 8:30 AM (job scan)
#
# Usage: bash install-local.sh
# Uninstall: bash install-local.sh --uninstall
# ═══════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_DIR="$SCRIPT_DIR/launchd"

PROFILE_PLIST="com.careerops.profile-update.plist"
DIGEST_PLIST="com.careerops.job-digest.plist"
AUTO_APPLY_PLIST="com.careerops.auto-apply.plist"
PLISTS=("$PROFILE_PLIST" "$DIGEST_PLIST" "$AUTO_APPLY_PLIST")
STALE_PLISTS=("com.careerops.profile-update-gulf.plist" "com.careerops.auto-apply-gulf.plist")

if [ "$1" = "--uninstall" ]; then
    echo "🗑️  Uninstalling career-ops agents..."
    for plist in "${PLISTS[@]}" "${STALE_PLISTS[@]}"; do
        launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null || launchctl unload "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null
        rm -f "$LAUNCH_AGENTS_DIR/$plist"
    done
    echo "✅ Uninstalled. Agents will no longer run."
    exit 0
fi

echo "═══════════════════════════════════════════════════════════"
echo "  📋 Career-Ops Local Agent Installer"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Create logs dir
mkdir -p "$SCRIPT_DIR/logs"

# Copy plist files to LaunchAgents
echo "📂 Installing to $LAUNCH_AGENTS_DIR..."
for plist in "${PLISTS[@]}"; do
    cp "$PLIST_DIR/$plist" "$LAUNCH_AGENTS_DIR/"
done
for plist in "${STALE_PLISTS[@]}"; do
    launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null || launchctl unload "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null
    rm -f "$LAUNCH_AGENTS_DIR/$plist"
done

# Load the agents
echo "🔄 Loading agents..."
for plist in "${PLISTS[@]}"; do
    launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null || launchctl unload "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null || launchctl load "$LAUNCH_AGENTS_DIR/$plist"
done

echo ""
echo "✅ Installed! Agents are now scheduled:"
echo ""
echo "  ⏰ 8:00 AM daily — Naukri profile update (name toggle)"
echo "  ⏰ 8:30 AM daily — Job scan (Naukri + LinkedIn) + email digest"
echo "  ⏰ 8:45 AM daily — Naukri auto-apply from approved queue"
echo ""
echo "  Logs: $SCRIPT_DIR/logs/"
echo ""
echo "  Check status:"
echo "    launchctl list | grep careerops"
echo ""
echo "  Manual trigger (test now):"
echo "    launchctl start com.careerops.profile-update"
echo "    launchctl start com.careerops.job-digest"
echo "    launchctl start com.careerops.auto-apply"
echo ""
echo "  Uninstall:"
echo "    bash install-local.sh --uninstall"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "⚠️  NOTE: Your Mac must be AWAKE at 8:00/8:30 AM for this to run."
echo "  If your Mac is asleep, it will run the missed job when it wakes up."
echo "  If it was OFF (shutdown), the missed job will NOT run."
echo ""
echo "  Tips to ensure it runs:"
echo "    • Keep Mac plugged in overnight with lid open (external display)"
echo "    • OR set auto-wake: System Settings → Battery → Schedule → Wake at 7:55 AM"
echo "    • OR just open your laptop before 8 AM (catches up automatically)"
echo ""
