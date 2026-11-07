#!/usr/bin/env node

/**
 * naukrigulf-login.mjs — One-time manual login to save Naukri Gulf browser session
 *
 * Uses Playwright's persistent browser context (like a real Chrome profile).
 * You log in ONCE via Gmail/Google. The session persists in data/naukrigulf-session/
 * All future Naukri Gulf scripts reuse this session — no re-login needed.
 *
 * Re-run only when session expires (~2-4 weeks).
 *
 * Usage:
 *   node naukrigulf-login.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const SESSION_DIR = 'data/naukrigulf-session';

mkdirSync('data', { recursive: true });

console.log('═══════════════════════════════════════════════');
console.log('  🔐 Naukri Gulf Login — One-Time Setup');
console.log('═══════════════════════════════════════════════\n');
console.log('A browser window will open. Please:\n');
console.log('  1. Click "Login with Google" on Naukri Gulf');
console.log('  2. Complete the Google sign-in');
console.log('  3. Wait until you see the Naukri Gulf dashboard');
console.log('     (your name visible at top-right)\n');

const context = await chromium.launchPersistentContext(SESSION_DIR, {
  headless: false,
  viewport: { width: 1366, height: 768 },
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
  ],
});

// Hide automation signals
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const page = context.pages()[0] || await context.newPage();
await page.goto('https://www.naukrigulf.com/jobseeker/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

console.log('⏳ Browser opened. Waiting for login to complete...');
console.log('   (Script will auto-detect when you reach the dashboard)\n');

// Poll every 3 seconds to check if login completed
let loggedIn = false;
for (let i = 0; i < 100; i++) { // 5 minutes max
  await new Promise(r => setTimeout(r, 3000));

  const pages = context.pages();
  for (const p of pages) {
    const url = p.url();
    if (url.includes('naukrigulf.com') && !url.includes('/login') && !url.includes('/register') && !url.includes('accounts.google')) {
      // Check if on a logged-in page (dashboard, jobs, profile)
      if (url.includes('/dashboard') || url.includes('/mnjuser') || url.includes('/jobseeker/') || url === 'https://www.naukrigulf.com/') {
        loggedIn = true;
        break;
      }
    }
  }

  if (loggedIn) break;

  const mainUrl = page.url();
  if (mainUrl.includes('naukrigulf.com') && !mainUrl.includes('/login') && !mainUrl.includes('/register')) {
    loggedIn = true;
    break;
  }

  if (i % 10 === 9) {
    console.log('   Still waiting... (complete the Google sign-in in browser)');
  }
}

if (loggedIn) {
  await new Promise(r => setTimeout(r, 2000));
  console.log('\n✅ Login successful! Session saved.');
  console.log(`   Browser state: ${SESSION_DIR}/`);
  console.log('   Naukri Gulf scans will now use this session.\n');
} else {
  console.log('\n⚠️  Login not detected (5 min timeout). Session saved anyway.');
  console.log('   If not fully logged in, run this script again.\n');
}

await context.close();
