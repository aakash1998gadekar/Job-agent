#!/usr/bin/env node

/**
 * lib/naukri-session.mjs — Shared Naukri session management
 *
 * Uses Playwright persistent context (saved browser profile) or
 * storageState JSON for headless environments (GitHub Actions).
 *
 * Login flow: run `node naukri-login.mjs` once → saves session to
 * data/naukri-session/ (persistent browser) and data/naukri-storage-state.json.
 * All scripts reuse this without re-login.
 */

import { existsSync } from 'fs';
import { chromium } from 'playwright';
import { clearStaleChromiumProfileLock } from './chromium-profile-lock.mjs';

const SESSION_DIR = 'data/naukri-session';
const STORAGE_STATE_PATH = 'data/naukri-storage-state.json';

/**
 * Create a Naukri-authenticated Playwright context.
 * 
 * - Locally: uses persistent context (full browser state)
 * - CI/GitHub Actions: uses storageState JSON or NAUKRI_STORAGE env var
 * 
 * @param {object} opts - { headless?: boolean }
 * @returns {Promise<{ context, browser: null }>} For persistent context, browser is null
 */
export async function createNaukriSession(opts = {}) {
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  // Naukri blocks headless browsers (Akamai) — must use headed mode locally
  const headless = opts.headless ?? isCI;

  // CI mode: use storageState (from env var or file)
  if (isCI) {
    let storageState;
    if (process.env.NAUKRI_STORAGE) {
      storageState = JSON.parse(process.env.NAUKRI_STORAGE);
    } else if (existsSync(STORAGE_STATE_PATH)) {
      storageState = STORAGE_STATE_PATH;
    } else {
      throw new Error(
        'No Naukri session for CI. Set NAUKRI_STORAGE secret (JSON from data/naukri-storage-state.json)'
      );
    }

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      storageState,
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    return { context, browser };
  }

  // Local mode: use persistent context (full browser session)
  if (!existsSync(SESSION_DIR)) {
    throw new Error(
      'No Naukri session found.\n' +
      '  Run: node naukri-login.mjs\n' +
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

  return { context, browser: null };
}

/**
 * Verify the Naukri session is still valid.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function verifySession(page) {
  try {
    await page.goto('https://www.naukri.com/mnjuser/homepage', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 2000));

    const url = page.url();
    // If redirected to login, session expired
    if (url.includes('nlogin') || url.includes('/login')) {
      return false;
    }

    // Check for Access Denied (Akamai)
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
    if (bodyText.includes('Access Denied')) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Close the session properly.
 * @param {{ context, browser }} session
 */
export async function closeSession(session) {
  await session.context.close();
  if (session.browser) await session.browser.close();
}
