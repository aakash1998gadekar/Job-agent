#!/usr/bin/env node

/**
 * linkedin-login.mjs — One-time manual login to save LinkedIn browser session
 *
 * Uses Playwright's persistent browser context (like a real Chrome profile).
 * You log in ONCE manually. The session persists in data/linkedin-session/
 * All future LinkedIn scans reuse this session — no re-login needed.
 *
 * Re-run only when session expires (~1-2 weeks).
 *
 * Usage:
 *   node linkedin-login.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const SESSION_DIR = 'data/linkedin-session';
const EMAIL = process.env.LINKEDIN_EMAIL || 'aakash1998gadekar@gmail.com';
const PASSWORD = process.env.LINKEDIN_PASSWORD || 'Aakash16@';

mkdirSync('data', { recursive: true });

console.log('═══════════════════════════════════════════════');
console.log('  🔐 LinkedIn Login — One-Time Setup');
console.log('═══════════════════════════════════════════════\n');
console.log('Auto-filling credentials. If CAPTCHA appears,');
console.log('complete it manually in the browser.\n');

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
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 2000));

// Auto-fill credentials
try {
  await page.locator('#username').fill(EMAIL);
  await new Promise(r => setTimeout(r, 500));
  await page.locator('#password').fill(PASSWORD);
  await new Promise(r => setTimeout(r, 500));
  await page.locator('#password').press('Enter');
  console.log('✍️  Credentials submitted. Waiting for feed...');
} catch (e) {
  console.log(`⚠️  Auto-fill failed: ${e.message}`);
  console.log('   Please log in manually in the browser.');
}

console.log('⏳ Waiting for login to complete...\n');

// Poll every 3 seconds to check if login completed
let loggedIn = false;
for (let i = 0; i < 100; i++) { // 5 minutes max
  await new Promise(r => setTimeout(r, 3000));

  const pages = context.pages();
  for (const p of pages) {
    const url = p.url();
    if (url.includes('linkedin.com/feed') || url.includes('linkedin.com/jobs') || url.includes('linkedin.com/in/')) {
      loggedIn = true;
      break;
    }
  }

  if (loggedIn) break;

  const mainUrl = page.url();
  if (mainUrl.includes('linkedin.com/feed') || mainUrl.includes('linkedin.com/jobs') || mainUrl.includes('linkedin.com/in/')) {
    loggedIn = true;
    break;
  }

  if (i % 10 === 9) {
    console.log('   Still waiting... (complete the login in browser)');
  }
}

if (loggedIn) {
  // Give it a moment to settle
  await new Promise(r => setTimeout(r, 2000));
  console.log('\n✅ Login successful! Session saved.');
  console.log(`   Browser state: ${SESSION_DIR}/`);
  console.log('   LinkedIn scans will now use this session.\n');
} else {
  console.log('\n⚠️  Login not detected (5 min timeout). Session saved anyway.');
  console.log('   If not fully logged in, run this script again.\n');
}

await context.close();
