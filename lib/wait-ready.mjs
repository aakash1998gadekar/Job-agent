/**
 * lib/wait-ready.mjs — Wait for system readiness after sleep/wake
 *
 * When launchd triggers a missed job after macOS wakes from sleep,
 * the network may not be ready yet. This module waits for internet
 * connectivity before proceeding.
 */

import dns from 'dns';

/**
 * Wait for internet connectivity by resolving a DNS name.
 * @param {number} maxWaitMs — Maximum time to wait (default: 300s / 5 min)
 * @param {number} intervalMs — Check interval (default: 5s)
 * @returns {Promise<boolean>} true if connected, false if timed out
 */
export async function waitForNetwork(maxWaitMs = 300000, intervalMs = 5000) {
  const start = Date.now();

  // Try to kick network interfaces after sleep
  try {
    const { execSync } = await import('child_process');
    // Try WiFi
    execSync('networksetup -setairportpower en0 on 2>/dev/null || true', { timeout: 5000 });
    // Force DHCP renew on all active interfaces
    execSync('ipconfig getifaddr en0 >/dev/null 2>&1 || ipconfig set en0 DHCP 2>/dev/null || true', { timeout: 5000 });
  } catch {}

  let attempts = 0;
  while (Date.now() - start < maxWaitMs) {
    attempts++;
    try {
      await new Promise((resolve, reject) => {
        dns.resolve('www.google.com', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      if (attempts > 1) {
        console.log(`  ✅ Network ready (took ${Math.round((Date.now() - start) / 1000)}s)`);
      }
      return true; // Connected
    } catch {
      // Every 30s, try kicking the network again
      if (attempts % 6 === 0) {
        try {
          const { execSync } = await import('child_process');
          execSync('networksetup -setairportpower en0 on 2>/dev/null || true', { timeout: 5000 });
          execSync('ipconfig set en0 DHCP 2>/dev/null || true', { timeout: 5000 });
        } catch {}
      }
      // Not connected yet, wait and retry
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  return false; // Timed out
}
