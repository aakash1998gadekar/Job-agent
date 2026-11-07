#!/usr/bin/env node

/**
 * scan-naukri.mjs — Naukri job scraper using Playwright + saved cookies
 *
 * Uses session cookies saved by naukri-login.mjs (one-time manual login).
 * No re-login needed — cookies are reused until they expire (~2-4 weeks).
 *
 * Usage:
 *   node scan-naukri.mjs              # scan and return new jobs
 *   node scan-naukri.mjs --dry-run    # preview without writing history
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { loadAgentConfig } from './lib/config-loader.mjs';
import { buildTitleFilter } from './lib/title-filter.mjs';
import { loadSeenIds, ensureHistoryFile, appendToHistory } from './lib/dedup.mjs';
import { createNaukriSession, verifySession, closeSession } from './lib/naukri-session.mjs';

// ── Config ──────────────────────────────────────────────────────────

const HISTORY_PATH = 'data/naukri-history.tsv';
const HISTORY_HEADER = 'jobId\turl\ttitle\tcompany\tlocation\tsalary\tfirstSeen\tstatus';
const MAX_PAGES = 8;
const PAGE_DELAY_MS = 3000;
const ACTION_DELAY_MS = 1500;

mkdirSync('data', { recursive: true });

// ── URL builder ─────────────────────────────────────────────────────

function buildSearchUrl(keyword, locations, experience) {
  // Naukri URL format: https://www.naukri.com/{keyword}-jobs-in-{location}?experience={range}
  const kw = keyword.toLowerCase().replace(/\s+/g, '-');
  const loc = Array.isArray(locations) && locations.length > 0
    ? locations.map(l => l.toLowerCase().replace(/\s+/g, '-')).join('%2C')
    : '';

  let url = `https://www.naukri.com/${kw}-jobs`;
  if (loc) url += `-in-${loc}`;
  url += `?sortBy=date`;
  if (experience) url += `&experience=${experience}`;

  return url;
}

// ── Job extraction ──────────────────────────────────────────────────

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const jobs = [];
    // Naukri job card selectors (updated for current DOM structure)
    const cards = document.querySelectorAll('.srp-jobtuple-wrapper, article.jobTuple, .cust-job-tuple');

    for (const card of cards) {
      try {
        const titleEl = card.querySelector('.title, a.title, .row1 a, .jobTuple__title a');
        const companyEl = card.querySelector('.comp-name, .subTitle a, .jobTuple__company a');
        const locationEl = card.querySelector('.loc-wrap .locWdth, .loc-wrap span, .jobTuple__location');
        const salaryEl = card.querySelector('.sal-wrap span, .jobTuple__salary');
        const urlEl = titleEl?.closest('a') || card.querySelector('a[href*="job-listings"]');

        const url = urlEl?.href || '';
        // Extract job ID from URL
        const jobIdMatch = url.match(/jid=(\w+)|[-_](\d{10,})/);
        const jobId = jobIdMatch ? (jobIdMatch[1] || jobIdMatch[2]) : url;

        if (titleEl && url) {
          jobs.push({
            title: titleEl.textContent?.trim() || '',
            company: companyEl?.textContent?.trim() || '',
            location: locationEl?.textContent?.trim() || '',
            salary: salaryEl?.textContent?.trim() || '',
            url: url,
            jobId: jobId,
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
  const jitter = Math.random() * 1500;
  return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
}

// ── Main scanner ────────────────────────────────────────────────────

export async function scanNaukri(options = {}) {
  const config = loadAgentConfig();
  const dryRun = options.dryRun || process.argv.includes('--dry-run');

  if (config.naukri.keywords.length === 0) {
    console.log('⚠️  No Naukri keywords configured. Add agents.naukri.keywords to config/profile.yml');
    return [];
  }

  // Load existing history for dedup
  ensureHistoryFile(HISTORY_PATH, HISTORY_HEADER);
  const seenIds = loadSeenIds(HISTORY_PATH);
  const titleFilter = config.title_filter ? buildTitleFilter(config.title_filter) : null;

  const allNewJobs = [];
  const stats = { total: 0, filtered: 0, dupes: 0, added: 0 };

  console.log(`🔍 Scanning Naukri for: ${config.naukri.keywords.join(', ')}`);
  console.log(`📍 Location: ${config.naukri.location.join(', ') || 'All India'}`);
  console.log(`📊 Experience: ${config.naukri.experience_range} years\n`);

  const session = await createNaukriSession();
  const { context } = session;
  const page = context.pages()[0] || await context.newPage();

  try {
    // Verify session is still valid
    console.log('  🔑 Loading saved session...');
    const valid = await verifySession(page);
    if (!valid) {
      throw new Error(
        'Naukri session expired. Run: node naukri-login.mjs (one-time browser login)'
      );
    }
    console.log('  ✅ Session active\n');

    for (const keyword of config.naukri.keywords) {
      const searchUrl = buildSearchUrl(keyword, config.naukri.location, config.naukri.experience_range);
      console.log(`  🔎 Searching: ${keyword}`);

      for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        const url = pageNum === 1 ? searchUrl : `${searchUrl}&pageNo=${pageNum}`;

        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await randomDelay(ACTION_DELAY_MS);

          // Wait for job cards to appear (try multiple selectors)
          await page.waitForSelector(
            '.srp-jobtuple-wrapper, article.jobTuple, .cust-job-tuple, [class*="jobTuple"], [class*="tuple-"], .list-container .jobTupleHeader, a[href*="job-listings"]',
            { timeout: 10000 }
          ).catch(() => null); // May not have results

          const jobs = await extractJobsFromPage(page);

          if (jobs.length === 0) {
            console.log(`     Page ${pageNum}: no results, stopping pagination`);
            break;
          }

          for (const job of jobs) {
            stats.total++;

            // Dedup check
            if (seenIds.has(job.jobId)) {
              stats.dupes++;
              continue;
            }

            // Title filter
            if (titleFilter && !titleFilter(job.title)) {
              stats.filtered++;
              continue;
            }

            // New job found
            job.source = 'naukri';
            job.firstSeen = new Date().toISOString().split('T')[0];
            allNewJobs.push(job);
            seenIds.add(job.jobId); // Prevent intra-scan dupes
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
  } finally {
    await closeSession(session);
  }

  // Write to history (unless dry run)
  if (!dryRun && allNewJobs.length > 0) {
    const lines = allNewJobs.map(j =>
      `${j.jobId}\t${j.url}\t${j.title}\t${j.company}\t${j.location}\t${j.salary}\t${j.firstSeen}\tadded`
    );
    appendToHistory(HISTORY_PATH, lines);
  }

  console.log(`\n📊 Naukri scan complete:`);
  console.log(`   Total: ${stats.total} | New: ${stats.added} | Filtered: ${stats.filtered} | Dupes: ${stats.dupes}`);
  if (dryRun) console.log('   (dry-run — nothing written)');

  return allNewJobs;
}

// ── CLI entrypoint ──────────────────────────────────────────────────

if (process.argv[1]?.endsWith('scan-naukri.mjs')) {
  scanNaukri().then(jobs => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(jobs, null, 2));
    }
  }).catch(err => {
    console.error('❌ Naukri scan failed:', err.message);
    process.exit(1);
  });
}
