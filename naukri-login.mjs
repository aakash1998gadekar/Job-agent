#!/usr/bin/env node

/**
 * naukri-login.mjs — One-time manual login to save browser session
 *
 * Uses Playwright's persistent browser context (like a real Chrome profile).
 * You log in ONCE via Google. The session persists in data/naukri-session/
 * All future scripts reuse this session — no re-login needed.
 *
 * Re-run only when session expires (~2-4 weeks).
 *
 * Usage:
 *   node naukri-login.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'fs';

const SESSION_DIR = 'data/naukri-session';
const STORAGE_STATE_PATH = 'data/naukri-storage-state.json';

mkdirSync('data', { recursive: true });

console.log('═══════════════════════════════════════════════');
console.log('  🔐 Naukri Login — One-Time Setup');
console.log('═══════════════════════════════════════════════\n');
console.log('A browser window will open. Please:\n');
console.log('  1. Click "Login with Google" on Naukri');
console.log('  2. Complete the Google sign-in');
console.log('  3. Wait until you see the Naukri dashboard');
console.log('     (your name visible at top-right)');
console.log('  4. Come back here and press ENTER\n');

// Use persistent context — saves ALL browser state like a real Chrome profile
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

const page = context.pages()[0] || await context.newPage();
await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

console.log('⏳ Browser opened. Waiting for login to complete...');
console.log('   (Script will auto-detect when you reach the dashboard)\n');
console.log('   Steps in the browser:');
console.log('   1. Click "Login with Google"');
console.log('   2. Pick your Google account');
console.log('   3. Wait for redirect to Naukri dashboard\n');

// Poll every 3 seconds to check if login completed
let loggedIn = false;
for (let i = 0; i < 100; i++) { // 5 minutes max
  await new Promise(r => setTimeout(r, 3000));
  
  // Check all pages in context (Google may have redirected)
  const pages = context.pages();
  for (const p of pages) {
    const url = p.url();
    if (url.includes('naukri.com') && !url.includes('nlogin') && !url.includes('/login') && !url.includes('accounts.google')) {
      loggedIn = true;
      break;
    }
  }
  
  if (loggedIn) break;
  
  // Also check if main page URL changed
  const mainUrl = page.url();
  if (mainUrl.includes('naukri.com') && !mainUrl.includes('nlogin') && !mainUrl.includes('/login')) {
    loggedIn = true;
    break;
  }
  
  if (i % 10 === 9) {
    console.log('   Still waiting... (complete the Google sign-in in browser)');
  }
}

if (!loggedIn) {
  console.log('⏰ Timeout (5 minutes). Saving session anyway...');
}

// Save storage state (cookies + localStorage + sessionStorage)
await context.storageState({ path: STORAGE_STATE_PATH });

if (loggedIn) {
  console.log('\n✅ Login successful! Session saved.');
  console.log(`   Storage: ${STORAGE_STATE_PATH}`);
  console.log(`   Browser state: ${SESSION_DIR}/`);
  console.log('   All Naukri scripts will now work without re-login.\n');
} else {
  console.log('\n⚠️  Login not detected. Session saved but may not be authenticated.');
  console.log('   Try running: node scan-naukri.mjs --dry-run');
  console.log('   If it fails, run this script again and complete the login.\n');
}

await context.close();
