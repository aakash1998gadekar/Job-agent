#!/usr/bin/env node

/**
 * scan-linkedin.mjs — LinkedIn job scraper
 *
 * Strategy A: Public LinkedIn Jobs page (no auth, ~25 results per keyword)
 * Strategy B: Playwright with login (fallback if Strategy A is blocked)
 *
 * Usage:
 *   node scan-linkedin.mjs              # scan and return new jobs
 *   node scan-linkedin.mjs --dry-run    # preview without writing history
 */

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'fs';
import { loadAgentConfig } from './lib/config-loader.mjs';
import { buildTitleFilter } from './lib/title-filter.mjs';
import { loadSeenIds, ensureHistoryFile, appendToHistory } from './lib/dedup.mjs';
import { clearStaleChromiumProfileLock } from './lib/chromium-profile-lock.mjs';

const LINKEDIN_SESSION_DIR = 'data/linkedin-session';

// ── Config ──────────────────────────────────────────────────────────

const HISTORY_PATH = 'data/linkedin-history.tsv';
const HISTORY_HEADER = 'jobId\turl\ttitle\tcompany\tlocation\tsalary\tfirstSeen\tstatus';
const MAX_PAGES = 4;
const PAGE_DELAY_MS = 5000;

mkdirSync('data', { recursive: true });

// ── URL builder ─────────────────────────────────────────────────────

function buildSearchUrl(keyword, config, start = 0) {
  const params = new URLSearchParams({
    keywords: keyword,
    location: config.location,
    f_TPR: config.time_filter, // r86400 = past 24h
    sortBy: 'DD', // Date posted
    start: start.toString(),
  });

  if (config.geo_id) params.set('geoId', config.geo_id);
  if (config.remote_filter) params.set('f_WT', '2'); // Remote only

  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

// ── Public page extraction (Strategy A) ─────────────────────────────

async function extractJobsPublicPage(page) {
  // Scroll down to trigger lazy-loading of job cards
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 2000));

  return page.evaluate(() => {
    const jobs = [];
    // LinkedIn current job search selectors (2024-2025)
    const cards = document.querySelectorAll(
      '.jobs-search__results-list > li, .base-search-card--link, [data-tracking-control-name="public_jobs_jserp-result"]'
    );

    for (const card of cards) {
      try {
        const titleEl = card.querySelector('.base-search-card__title, .sr-only, h3.base-search-card__title');
        const companyEl = card.querySelector('.base-search-card__subtitle a, h4.base-search-card__subtitle a, .hidden-nested-link');
        const locationEl = card.querySelector('.job-search-card__location, .base-search-card__metadata span');
        const urlEl = card.querySelector('a.base-card__full-link, a[href*="/jobs/view/"]');

        const url = urlEl?.href || '';
        const jobIdMatch = url.match(/\/jobs\/view\/(\d{5,})/); // Must be 5+ digits
        const jobId = jobIdMatch ? jobIdMatch[1] : '';

        const title = titleEl?.textContent?.trim() || '';

        if (title && jobId && title.length > 3) {
          jobs.push({
            title: title,
            company: companyEl?.textContent?.trim() || '',
            location: locationEl?.textContent?.trim() || '',
            salary: '',
            url: `https://www.linkedin.com/jobs/view/${jobId}/`,
            jobId: jobId,
            postedDate: '',
          });
        }
      } catch (e) {
        // Skip malformed cards
      }
    }
    return jobs;
  });
}

// ── Authenticated extraction (Strategy B) ───────────────────────────

async function loginToLinkedIn(page, email, password) {
  console.log('  🔐 Attempting LinkedIn login...');
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'load', timeout: 45000 });
  await randomDelay(5000);

  // Wait for login form — retry once if selector not visible (LinkedIn can be slow)
  try {
    await page.waitForSelector('#username', { state: 'visible', timeout: 30000 });
  } catch {
    console.log('  ⚠️  Login form slow, reloading...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(5000);
    await page.waitForSelector('#username', { state: 'visible', timeout: 30000 });
  }

  // Use exact IDs from LinkedIn login page
  await page.locator('#username').fill(email);
  await randomDelay(800);
  await page.locator('#password').fill(password);
  await randomDelay(500);
  await page.locator('#password').press('Enter');

  // Wait for redirect to feed or checkpoint
  await page.waitForURL(/\/(feed|checkpoint|jobs|in\/)/, { timeout: 20000 }).catch(() => null);

  const currentUrl = page.url();
  if (currentUrl.includes('checkpoint') || currentUrl.includes('challenge')) {
    throw new Error('LinkedIn requires verification (CAPTCHA/2FA). Manual login needed.');
  }
  if (currentUrl.includes('login')) {
    throw new Error('Login failed — still on login page. Check credentials.');
  }

  console.log('  ✅ LinkedIn login successful');
}

async function extractJobsAuthenticated(page) {
  // Scroll to trigger lazy-loading
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 2000));

  return page.evaluate(() => {
    const jobs = [];
    const seen = new Set();
    // Primary: scaffold list items (LinkedIn 2025+)
    const cards = document.querySelectorAll('.scaffold-layout__list-item, li.ember-view.occludable-update, .job-card-container, [data-job-id]');

    for (const card of cards) {
      try {
        const urlEl = card.querySelector('a[href*="/jobs/view/"]');
        const url = urlEl?.href || '';
        const jobIdMatch = url.match(/\/jobs\/view\/(\d{5,})/);
        const jobId = jobIdMatch ? jobIdMatch[1] : (card.getAttribute('data-job-id') || '');

        if (!jobId || seen.has(jobId)) continue;
        seen.add(jobId);

        // Get title from the link text or nearby elements
        let title = '';
        const titleEl = urlEl || card.querySelector('.job-card-list__title, .artdeco-entity-lockup__title, [class*="job-card"] strong');
        if (titleEl) {
          title = titleEl.textContent.trim().split('\n')[0].trim();
          // Remove duplicate text (LinkedIn renders title twice)
          if (title.length > 10) {
            const half = Math.floor(title.length / 2);
            if (title.substring(0, half) === title.substring(half)) {
              title = title.substring(0, half);
            }
          }
          title = title.replace(/with verification$/i, '').trim();
        }

        const companyEl = card.querySelector('.artdeco-entity-lockup__subtitle, .job-card-container__primary-description, .job-card-container__company-name, [class*="company"]');
        const locationEl = card.querySelector('.artdeco-entity-lockup__caption, .job-card-container__metadata-item, .job-card-container__metadata-wrapper, [class*="location"]');

        if (title && jobId && title.length > 3) {
          jobs.push({
            title,
            company: companyEl?.textContent?.trim().split('\n')[0].trim() || '',
            location: locationEl?.textContent?.trim().split('\n')[0].trim() || '',
            salary: '',
            url: `https://www.linkedin.com/jobs/view/${jobId}/`,
            jobId,
          });
        }
      } catch (e) {
        // Skip malformed cards
      }
    }
    return jobs;
  });
}

// ── Random delay ────────────────────────────────────────────────────

function randomDelay(baseMs) {
  const jitter = Math.random() * 1000;
  return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
}

// ── Main scanner ────────────────────────────────────────────────────

export async function scanLinkedIn(options = {}) {
  const config = loadAgentConfig();
  const dryRun = options.dryRun || process.argv.includes('--dry-run');
  const linkedinConfig = config.linkedin;

  if (linkedinConfig.keywords.length === 0) {
    console.log('⚠️  No LinkedIn keywords configured. Add agents.linkedin.keywords to config/profile.yml');
    return [];
  }

  ensureHistoryFile(HISTORY_PATH, HISTORY_HEADER);
  const seenIds = loadSeenIds(HISTORY_PATH);
  const titleFilter = config.title_filter ? buildTitleFilter(config.title_filter) : null;

  const allNewJobs = [];
  const stats = { total: 0, filtered: 0, dupes: 0, added: 0 };

  console.log(`🔍 Scanning LinkedIn for: ${linkedinConfig.keywords.join(', ')}`);
  console.log(`📍 Location: ${linkedinConfig.location}`);
  console.log(`⏰ Time filter: ${linkedinConfig.time_filter}\n`);

  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const hasPersistentSession = existsSync(LINKEDIN_SESSION_DIR);
  let browser = null;
  let context;
  let page;
  let useAuth = false;

  if (hasPersistentSession && !isCI) {
    // Use persistent session (preferred — no login needed)
    console.log('  🔑 Using saved LinkedIn session...');
    clearStaleChromiumProfileLock(LINKEDIN_SESSION_DIR);
    context = await chromium.launchPersistentContext(LINKEDIN_SESSION_DIR, {
      headless: false,
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    page = context.pages()[0] || await context.newPage();

    // Verify session by checking if we can access LinkedIn feed
    try {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));
      const url = page.url();
      if (url.includes('/login') || url.includes('authwall')) {
        console.log('  ⚠️  Session expired. Run: node linkedin-login.mjs');
        console.log('      Falling back to credential login...');
      } else {
        useAuth = true;
        console.log('  ✅ LinkedIn session active');
      }
    } catch (e) {
      console.log(`  ⚠️  Session check failed: ${e.message}`);
    }
  }

  if (!useAuth) {
    // Fallback: fresh browser + credential login
    if (context) {
      await context.close().catch(() => {});
    }
    browser = await chromium.launch({
      headless: isCI,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    page = await context.newPage();

    if (linkedinConfig.email && linkedinConfig.password) {
      console.log('  🔐 Attempting credential login...');
      try {
        await loginToLinkedIn(page, linkedinConfig.email, linkedinConfig.password);
        useAuth = true;
      } catch (e) {
        console.log(`  ⚠️  Login failed: ${e.message}. Falling back to public mode.`);
      }
    } else {
      console.log('  ℹ️  No session or credentials. Using public mode (limited results).');
      console.log('      Run: node linkedin-login.mjs  (for full results)');
    }
  }

  try {
    for (const keyword of linkedinConfig.keywords) {
      console.log(`  🔎 Searching: ${keyword}`);

      for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
        const start = pageNum * 25;
        const searchUrl = buildSearchUrl(keyword, linkedinConfig, start);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await randomDelay(useAuth ? 5000 : 3000);

          // Check if we hit a login wall (when not authenticated)
          if (!useAuth) {
            const loginWall = await page.$('input#session_key, .authwall-join-form, .sign-in-form');
            if (loginWall) {
              console.log('  ⚠️  Login wall detected. Switching to authenticated mode...');
              if (linkedinConfig.email && linkedinConfig.password) {
                await loginToLinkedIn(page, linkedinConfig.email, linkedinConfig.password);
                useAuth = true;
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await randomDelay(3000);
              } else {
                console.log('  ❌ No LinkedIn credentials configured. Skipping.');
                break;
              }
            }
          }

          // Extract jobs based on mode
          const jobs = useAuth
            ? await extractJobsAuthenticated(page)
            : await extractJobsPublicPage(page);

          if (jobs.length === 0) {
            console.log(`     Page ${pageNum + 1}: no results, stopping`);
            break;
          }

          for (const job of jobs) {
            stats.total++;

            if (seenIds.has(job.jobId)) {
              stats.dupes++;
              continue;
            }

            if (titleFilter && !titleFilter(job.title)) {
              stats.filtered++;
              continue;
            }

            job.source = 'linkedin';
            job.firstSeen = new Date().toISOString().split('T')[0];
            allNewJobs.push(job);
            seenIds.add(job.jobId);
            stats.added++;
          }

          console.log(`     Page ${pageNum + 1}: ${jobs.length} found, ${stats.added} new so far`);

          if (pageNum < MAX_PAGES - 1) {
            await randomDelay(PAGE_DELAY_MS);
          }
        } catch (e) {
          console.log(`     Page ${pageNum + 1}: error — ${e.message}`);
          break;
        }
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    } else {
      await context.close().catch(() => {});
    }
  }

  // Write to history (unless dry run)
  if (!dryRun && allNewJobs.length > 0) {
    const lines = allNewJobs.map(j =>
      `${j.jobId}\t${j.url}\t${j.title}\t${j.company}\t${j.location}\t${j.salary}\t${j.firstSeen}\tadded`
    );
    appendToHistory(HISTORY_PATH, lines);
  }

  console.log(`\n📊 LinkedIn scan complete:`);
  console.log(`   Total: ${stats.total} | New: ${stats.added} | Filtered: ${stats.filtered} | Dupes: ${stats.dupes}`);
  if (dryRun) console.log('   (dry-run — nothing written)');

  return allNewJobs;
}

// ── CLI entrypoint ──────────────────────────────────────────────────

if (process.argv[1]?.endsWith('scan-linkedin.mjs')) {
  scanLinkedIn().then(jobs => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(jobs, null, 2));
    }
  }).catch(err => {
    console.error('❌ LinkedIn scan failed:', err.message);
    process.exit(1);
  });
}
