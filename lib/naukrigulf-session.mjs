#!/usr/bin/env node

/**
 * lib/naukrigulf-session.mjs — Shared Naukri Gulf session management
 *
 * Uses Playwright persistent context (saved browser profile).
 * Login flow: run `node naukrigulf-login.mjs` once → saves session to
 * data/naukrigulf-session/. All scripts reuse this without re-login.
 */

import { existsSync } from 'fs';
import { chromium } from 'playwright';
import { clearStaleChromiumProfileLock } from './chromium-profile-lock.mjs';

const SESSION_DIR = 'data/naukrigulf-session';

/**
 * Create a NaukriGulf-authenticated Playwright context.
 * Uses persistent context (full browser state).
 *
 * @param {object} opts - { headless?: boolean }
 * @returns {Promise<{ context, browser: null }>}
 */
export async function createNaukriGulfSession(opts = {}) {
  // NaukriGulf aggressively blocks headless browsers — always use headed mode.
  // On macOS launchd this works fine (has display). Only force headless if explicitly requested.
  const headless = opts.headless ?? false;

  if (!existsSync(SESSION_DIR)) {
    throw new Error(
      'No Naukri Gulf session found.\n' +
      '  Run: node naukrigulf-login.mjs\n' +
      '  Log in via Google once, session is saved for reuse.'
    );
  }

  clearStaleChromiumProfileLock(SESSION_DIR);

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless,
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

  return { context, browser: null };
}

/**
 * Verify the Naukri Gulf session is still valid.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function verifyNaukriGulfSession(page) {
  try {
    await page.goto('https://www.naukrigulf.com/jobseeker/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 2000));

    const url = page.url();
    // If redirected to login, session expired
    if (url.includes('/login') || url.includes('/register')) {
      return false;
    }

    // Check for access denied or empty page
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
    if (bodyText.includes('Access Denied') || bodyText.includes('Please login')) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Close the session gracefully.
 * @param {{ context, browser }} session
 */
export async function closeNaukriGulfSession(session) {
  try {
    if (session.browser) {
      await session.browser.close();
    } else if (session.context) {
      await session.context.close();
    }
  } catch {
    // Ignore cleanup errors
  }
}
