#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Career-Ops Job Agent — AWS EC2 Deployment Script
# ═══════════════════════════════════════════════════════════════
#
# Usage (from your laptop):
#   1. Launch a t2.micro Ubuntu 24.04 EC2 instance
#   2. Set your variables below
#   3. Run: bash deploy.sh
#
# This script will:
#   - SSH into your EC2 instance
#   - Install Node.js, Playwright, xvfb
#   - Upload your code + session files
#   - Set up cron jobs (8 AM IST profile update, 8:30 AM IST scan)
#   - Run a test to verify everything works
# ═══════════════════════════════════════════════════════════════

set -e

# ── CONFIGURE THESE ──────────────────────────────────────────
EC2_IP=""                              # Your EC2 public IP
KEY_FILE=""                            # Path to your .pem key file
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"  # This project folder
REMOTE_USER="ubuntu"
REMOTE_DIR="/home/ubuntu/job-agent"
# ─────────────────────────────────────────────────────────────

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Validation ───────────────────────────────────────────────
if [ -z "$EC2_IP" ]; then
  read -p "Enter your EC2 public IP: " EC2_IP
fi
if [ -z "$KEY_FILE" ]; then
  read -p "Enter path to .pem key file: " KEY_FILE
fi

[ -f "$KEY_FILE" ] || error "Key file not found: $KEY_FILE"
[ -f "$PROJECT_DIR/.env" ] || error ".env file not found in project"
[ -d "$PROJECT_DIR/data/naukri-session" ] || warn "No naukri-session/ found. Profile update won't work until you login."

SSH_CMD="ssh -i $KEY_FILE -o StrictHostKeyChecking=no $REMOTE_USER@$EC2_IP"
SCP_CMD="scp -i $KEY_FILE -o StrictHostKeyChecking=no"

log "Deploying to $REMOTE_USER@$EC2_IP..."

# ── Step 1: Install dependencies on EC2 ─────────────────────
log "Installing system dependencies..."
$SSH_CMD << 'REMOTE_INSTALL'
set -e
echo "=== Installing Node.js 20 =="
if ! command -v node &>/dev/null; th=en
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
  sudo apt install -y nodejs
fi
echo "Node: $(node --version)"

echo "=== Installing system packages ==="
sudo apt update -qq
sudo apt install -y git xvfb \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 \
  2>/dev/null || sudo apt install -y git xvfb \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1

mkdir -p /home/ubuntu/logs
echo "=== Dependencies installed ==="
REMOTE_INSTALL

# ── Step 2: Upload project files ─────────────────────────────
log "Uploading project files..."

# Create tarball (exclude node_modules, .git, large files)
cd "$PROJECT_DIR"
tar czf /tmp/job-agent.tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='data/naukri-session' \
  --exclude='output' \
  --exclude='*.pdf' \
  .

$SCP_CMD /tmp/job-agent.tar.gz $REMOTE_USER@$EC2_IP:/tmp/

$SSH_CMD << REMOTE_EXTRACT
set -e
rm -rf $REMOTE_DIR
mkdir -p $REMOTE_DIR
cd $REMOTE_DIR
tar xzf /tmp/job-agent.tar.gz
rm /tmp/job-agent.tar.gz
echo "=== Files extracted ==="
REMOTE_EXTRACT

# Upload session files separately (sensitive)
if [ -d "$PROJECT_DIR/data/naukri-session" ]; then
  log "Uploading Naukri session..."
  $SCP_CMD -r "$PROJECT_DIR/data/naukri-session" $REMOTE_USER@$EC2_IP:$REMOTE_DIR/data/
fi
if [ -f "$PROJECT_DIR/data/naukri-storage-state.json" ]; then
  $SCP_CMD "$PROJECT_DIR/data/naukri-storage-state.json" $REMOTE_USER@$EC2_IP:$REMOTE_DIR/data/
fi

# ── Step 3: Install npm packages & Playwright ────────────────
log "Installing npm packages + Playwright..."
$SSH_CMD << REMOTE_NPM
set -e
cd $REMOTE_DIR
npm ci --production 2>/dev/null || npm install --production
npx playwright install chromium
echo "=== npm + Playwright ready ==="
REMOTE_NPM

# ── Step 4: Set up cron jobs ─────────────────────────────────
log "Configuring cron jobs (8 AM & 8:30 AM IST)..."
$SSH_CMD << 'REMOTE_CRON'
set -e
# Remove old career-ops crons if any
crontab -l 2>/dev/null | grep -v "job-agent" > /tmp/current_cron || true

# Add new cron jobs
cat >> /tmp/current_cron << 'EOF'
# Career-Ops: Naukri profile update at 8:00 AM IST (2:30 AM UTC)
30 2 * * * cd /home/ubuntu/job-agent && xvfb-run --auto-servernum node naukri-profile-update.mjs >> /home/ubuntu/logs/profile-update.log 2>&1
# Career-Ops: Job scan + email digest at 8:30 AM IST (3:00 AM UTC)
0 3 * * * cd /home/ubuntu/job-agent && xvfb-run --auto-servernum node job-digest.mjs >> /home/ubuntu/logs/job-digest.log 2>&1
EOF

crontab /tmp/current_cron
rm /tmp/current_cron
echo "=== Cron configured ==="
crontab -l
REMOTE_CRON

# ── Step 5: Test run ─────────────────────────────────────────
log "Running test (profile update dry-run)..."
$SSH_CMD << REMOTE_TEST
set -e
cd $REMOTE_DIR
echo "--- Profile Update (dry-run) ---"
xvfb-run --auto-servernum node naukri-profile-update.mjs --dry-run
echo ""
echo "--- Config validation ---"
node -e "
import { loadAgentConfig, validateAgentConfig } from './lib/config-loader.mjs';
const c = loadAgentConfig();
validateAgentConfig(c, ['email']);
console.log('✅ Email config: OK');
console.log('   Naukri keywords:', c.naukri.keywords.length);
console.log('   LinkedIn keywords:', c.linkedin.keywords.length);
console.log('   Email to:', c.email.to);
"
REMOTE_TEST

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
log "✅ Deployment complete!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Instance: $REMOTE_USER@$EC2_IP"
echo "  Project:  $REMOTE_DIR"
echo "  Schedule:"
echo "    • 8:00 AM IST — Naukri profile update (name toggle)"
echo "    • 8:30 AM IST — Job scan + email digest"
echo ""
echo "  Logs:"
echo "    ssh -i $KEY_FILE $REMOTE_USER@$EC2_IP"
echo "    tail -f /home/ubuntu/logs/job-digest.log"
echo "    tail -f /home/ubuntu/logs/profile-update.log"
echo ""
echo "  Manual run:"
echo "    ssh -i $KEY_FILE $REMOTE_USER@$EC2_IP"
echo "    cd ~/job-agent && xvfb-run node job-digest.mjs"
echo ""
echo "  Refresh session (monthly):"
echo "    # On laptop: node naukri-login.mjs"
echo "    bash deploy.sh  # re-run to upload new session"
echo ""
