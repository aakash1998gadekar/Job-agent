#!/usr/bin/env node

/**
 * scan-naukrigulf.mjs — Naukri Gulf job scraper using Playwright + saved cookies
 *
 * Uses session cookies saved by naukrigulf-login.mjs (one-time manual login).
 * No re-login needed — cookies are reused until they expire (~2-4 weeks).
 *
 * Usage:
 *   node scan-naukrigulf.mjs              # scan and return new jobs
 *   node scan-naukrigulf.mjs --dry-run    # preview without writing history
 */

import { mkdirSync } from 'fs';
import { loadAgentConfig } from './lib/config-loader.mjs';
import { buildTitleFilter } from './lib/title-filter.mjs';
import { loadSeenIds, ensureHistoryFile, appendToHistory } from './lib/dedup.mjs';
import { createNaukriGulfSession, verifyNaukriGulfSession, closeNaukriGulfSession } from './lib/naukrigulf-session.mjs';

// ── Config ──────────────────────────────────────────────────────────

const HISTORY_PATH = 'data/naukrigulf-history.tsv';
const HISTORY_HEADER = 'jobId\turl\ttitle\tcompany\tlocation\tsalary\tfirstSeen\tstatus';
const MAX_PAGES = 5;
const PAGE_DELAY_MS = 4000;
const ACTION_DELAY_MS = 2000;

mkdirSync('data', { recursive: true });

// ── URL builder ─────────────────────────────────────────────────────

function buildSearchUrl(keyword, location) {
  // NaukriGulf URL format: https://www.naukrigulf.com/{keyword}-jobs-in-{location}
  const kw = keyword.toLowerCase().replace(/\s+/g, '-');
  let url = `https://www.naukrigulf.com/${kw}-jobs`;
  if (location) {
    const loc = location.toLowerCase().replace(/\s+/g, '-');
    url += `-in-${loc}`;
  }
  return url;
}

// ── Job extraction ──────────────────────────────────────────────────

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const jobs = [];
    // NaukriGulf job card selectors (multiple fallbacks)
    const cards = document.querySelectorAll(
      '.srp-tuple, .jobTuple, article[data-jid], .ng-box-list > li, [class*="job-card"], [class*="srp-j"]'
    );

    for (const card of cards) {
      try {
        const titleEl = card.querySelector(
          'a[class*="title"], a[href*="jid-"], h2 a, .designation a, .job-title a, a[class*="desig"]'
        );
        const companyEl = card.querySelector(
          '.comp-name, .company-name, [class*="company"], a[href*="cid-"]'
        );
        const locationEl = card.querySelector(
          '.location, [class*="loc"], .loc-wrap, [class*="location"]'
        );
        const salaryEl = card.querySelector(
          '.salary, [class*="salary"], [class*="sal"]'
        );

        const url = titleEl?.href || '';
        // Extract job ID from URL slug: jid-DDMMYY######
        const jobIdMatch = url.match(/jid-(\d{12,})/);
        const jobId = jobIdMatch ? jobIdMatch[1] : '';

        // Also try data attribute
        const dataJid = card.getAttribute('data-jid') || '';
        const finalJobId = jobId || dataJid;

        const title = titleEl?.textContent?.trim() || '';

        if (title && (finalJobId || url) && title.length > 3) {
          jobs.push({
            title,
            company: companyEl?.textContent?.trim() || '',
            location: locationEl?.textContent?.trim() || '',
            salary: salaryEl?.textContent?.trim() || '',
            url: url.startsWith('http') ? url : `https://www.naukrigulf.com${url}`,
            jobId: finalJobId || url,
          });
        }
      } catch (e) {
        // Skip malformed cards
      }
    }
    return jobs;
  });
}

// ── Random delay (anti-detection) ───────────────────────────────────

function randomDelay(baseMs) {
  const jitter = Math.random() * 2000;
  return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
}

// ── Main scanner ────────────────────────────────────────────────────

export async function scanNaukriGulf(options = {}) {
  const config = loadAgentConfig();
  const dryRun = options.dryRun || process.argv.includes('--dry-run');
  const gulfConfig = config.naukri_gulf;

  if (!gulfConfig || !gulfConfig.enabled) {
    console.log('⚠️  Naukri Gulf scanner disabled. Set agents.naukri_gulf.enabled: true in config/profile.yml');
    return [];
  }

  if (gulfConfig.keywords.length === 0) {
    console.log('⚠️  No Naukri Gulf keywords configured. Add agents.naukri_gulf.keywords to config/profile.yml');
    return [];
  }

  // Load existing history for dedup
  ensureHistoryFile(HISTORY_PATH, HISTORY_HEADER);
  const seenIds = loadSeenIds(HISTORY_PATH);
  const titleFilter = config.title_filter ? buildTitleFilter(config.title_filter) : null;

  const allNewJobs = [];
  const stats = { total: 0, filtered: 0, dupes: 0, added: 0 };

  console.log(`🔍 Scanning Naukri Gulf for: ${gulfConfig.keywords.join(', ')}`);
  console.log(`📍 Location: ${gulfConfig.location.join(', ') || 'All Gulf'}`);
  console.log(`📊 Experience: ${gulfConfig.experience_range} years\n`);

  const session = await createNaukriGulfSession();
  const { context } = session;
  const page = context.pages()[0] || await context.newPage();

  try {
    // Verify session is still valid
    console.log('  🔑 Loading saved session...');
    const valid = await verifyNaukriGulfSession(page);
    if (!valid) {
      throw new Error(
        'Naukri Gulf session expired. Run: node naukrigulf-login.mjs (one-time browser login)'
      );
    }
    console.log('  ✅ Session active\n');

    for (const keyword of gulfConfig.keywords) {
      // Scan each location separately for Gulf (different countries)
      const locations = gulfConfig.location.length > 0 ? gulfConfig.location : [''];

      for (const location of locations) {
        const searchUrl = buildSearchUrl(keyword, location);
        const label = location ? `${keyword} in ${location}` : keyword;
        console.log(`  🔎 Searching: ${label}`);

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
          const url = pageNum === 1 ? searchUrl : `${searchUrl}?page=${pageNum}`;

          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await randomDelay(ACTION_DELAY_MS);

            // Wait for job cards to appear
            await page.waitForSelector(
              '.srp-tuple, .jobTuple, article[data-jid], [class*="job-card"], a[href*="jid-"]',
              { timeout: 10000 }
            ).catch(() => null);

            const jobs = await extractJobsFromPage(page);

            if (jobs.length === 0) {
              console.log(`     Page ${pageNum}: no results, stopping pagination`);
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

              job.source = 'naukrigulf';
              job.firstSeen = new Date().toISOString().split('T')[0];
              allNewJobs.push(job);
              seenIds.add(job.jobId);
              stats.added++;
            }

            console.log(`     Page ${pageNum}: ${jobs.length} found, ${stats.added} new so far`);

            if (pageNum < MAX_PAGES) {
              await randomDelay(PAGE_DELAY_MS);
            }
          } catch (e) {
            console.log(`     Page ${pageNum}: error — ${e.message}`);
            break;
          }
        }
      }
    }
  } finally {
    await closeNaukriGulfSession(session);
  }

  // Write to history (unless dry run)
  if (!dryRun && allNewJobs.length > 0) {
    const lines = allNewJobs.map(j =>
      `${j.jobId}\t${j.url}\t${j.title}\t${j.company}\t${j.location}\t${j.salary}\t${j.firstSeen}\tadded`
    );
    appendToHistory(HISTORY_PATH, lines);
  }

  console.log(`\n📊 Naukri Gulf scan complete:`);
  console.log(`   Total: ${stats.total} | New: ${stats.added} | Filtered: ${stats.filtered} | Dupes: ${stats.dupes}`);
  if (dryRun) console.log('   (dry-run — nothing written)');

  return allNewJobs;
}

// ── CLI entrypoint ──────────────────────────────────────────────────

if (process.argv[1]?.endsWith('scan-naukrigulf.mjs')) {
  scanNaukriGulf().then(jobs => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(jobs, null, 2));
    }
  }).catch(err => {
    console.error('❌ Naukri Gulf scan failed:', err.message);
    process.exit(1);
  });
}
