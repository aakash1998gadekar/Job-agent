#!/usr/bin/env node

/**
 * naukri-extract-cookies.mjs — Extract Naukri cookies from your Chrome browser
 *
 * Instead of logging in through Playwright (which blocks Google OAuth popups),
 * this extracts cookies from your existing Chrome session where you're already
 * logged into Naukri.
 *
 * Prerequisites: You must be logged into Naukri in Chrome already.
 *
 * Usage:
 *   node naukri-extract-cookies.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const COOKIES_PATH = 'data/naukri-cookies.json';
mkdirSync('data', { recursive: true });

console.log('═══════════════════════════════════════════════');
console.log('  🍪 Naukri Cookie Extractor');
console.log('═══════════════════════════════════════════════\n');
console.log('This will open a Chromium browser with your Chrome profile.');
console.log('If you are already logged into Naukri in Chrome, cookies will');
console.log('be captured automatically.\n');

// Find Chrome user data directory
const chromeUserDataDir = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

console.log(`📁 Chrome profile: ${chromeUserDataDir}\n`);
console.log('⏳ Launching browser with your Chrome profile...\n');

try {
  // Launch with persistent context (reuses Chrome's cookies)
  const context = await chromium.launchPersistentContext(
    join(chromeUserDataDir, 'Default'), // Use "Default" profile
    {
      headless: false,
      channel: 'chrome',  // Use installed Chrome
      viewport: { width: 1366, height: 768 },
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    }
  );

  const page = context.pages()[0] || await context.newPage();
  
  // Navigate to Naukri to check if already logged in
  console.log('  🌐 Navigating to Naukri...');
  await page.goto('https://www.naukri.com/mnjuser/homepage', { 
    waitUntil: 'domcontentloaded', 
    timeout: 30000 
  });
  await new Promise(r => setTimeout(r, 3000));

  const currentUrl = page.url();
  console.log(`  📍 URL: ${currentUrl}\n`);

  if (currentUrl.includes('nlogin') || currentUrl.includes('/login')) {
    console.log('  ⚠️  Not logged in. Please log in manually in the browser window.');
    console.log('     After logging in and seeing the dashboard, press Enter here.\n');
    
    await new Promise((resolve) => {
      process.stdin.setRawMode?.(false);
      process.stdin.resume();
      process.stdin.once('data', () => resolve());
    });

    // Navigate again after login
    await page.goto('https://www.naukri.com/mnjuser/homepage', { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    await new Promise(r => setTimeout(r, 2000));
  }

  // Capture cookies
  const cookies = await context.cookies(['https://www.naukri.com']);
  const naukriCookies = cookies.filter(c => c.domain.includes('naukri.com'));

  // Check for auth cookies
  const authNames = ['NKWAP', 'nauk_at', 'nauk_sid', 'naukrip', 'PHPSESSID', 'sid', '_nkwap'];
  const foundAuth = naukriCookies.filter(c => 
    authNames.some(a => c.name.toLowerCase().includes(a.toLowerCase()))
  );

  writeFileSync(COOKIES_PATH, JSON.stringify(naukriCookies, null, 2), 'utf-8');

  console.log(`\n✅ Saved ${naukriCookies.length} cookies to ${COOKIES_PATH}`);
  if (foundAuth.length > 0) {
    console.log(`   Auth cookies found: ${foundAuth.map(c => c.name).join(', ')}`);
  }
  console.log('   Cookie names:', naukriCookies.map(c => c.name).join(', '));

  await context.close();
} catch (err) {
  if (err.message.includes('user data directory is already in use')) {
    console.log('❌ Chrome is currently running. Please either:');
    console.log('   1. Close Chrome completely, then run this again');
    console.log('   2. OR use: node naukri-login.mjs (separate browser)\n');
    console.log('   Alternative: Export cookies manually (see below)\n');
    printManualInstructions();
  } else {
    console.log(`❌ Error: ${err.message}\n`);
    printManualInstructions();
  }
  process.exit(1);
}

function printManualInstructions() {
  console.log('═══════════════════════════════════════════════');
  console.log('  📋 Manual Cookie Export (Fallback Method)');
  console.log('═══════════════════════════════════════════════\n');
  console.log('  1. Open Chrome and go to https://www.naukri.com');
  console.log('  2. Make sure you are logged in (see dashboard)');
  console.log('  3. Press F12 → Application tab → Cookies → www.naukri.com');
  console.log('  4. Look for cookies like: NKWAP, nauk_at, or any session cookies');
  console.log('  5. Or install "EditThisCookie" extension and export as JSON');
  console.log('  6. Save the JSON to: data/naukri-cookies.json\n');
}
