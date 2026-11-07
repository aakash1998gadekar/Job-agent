#!/usr/bin/env node

/**
 * auto-apply-naukrigulf.mjs — Automated Naukri Gulf job application engine
 *
 * Reads the to-apply queue (data/to-apply.json), applies to Gulf jobs
 * matching the threshold, fills standard form fields, and tracks results.
 *
 * Usage:
 *   node auto-apply-naukrigulf.mjs              # apply to top Gulf jobs
 *   node auto-apply-naukrigulf.mjs --dry-run    # detect apply buttons, don't submit
 *   node auto-apply-naukrigulf.mjs --limit 5    # apply to just 5 jobs
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { loadAgentConfig } from './lib/config-loader.mjs';
import { createNaukriGulfSession, verifyNaukriGulfSession, closeNaukriGulfSession } from './lib/naukrigulf-session.mjs';
import { waitForNetwork } from './lib/wait-ready.mjs';
import { sendAutoApplyReport } from './lib/email-notify.mjs';

// ── Config ──────────────────────────────────────────────────────────

const QUEUE_PATH = 'data/to-apply.json';
const HISTORY_PATH = 'data/apply-history.tsv';
const HISTORY_HEADER = 'jobId\turl\ttitle\tcompany\tmatchScore\tappliedAt\tstatus\tnotes';
const LOG_PATH = 'logs/auto-apply-gulf.log';

mkdirSync('data', { recursive: true });
mkdirSync('logs', { recursive: true });

// ── Helpers ─────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

function randomDelay(baseMs) {
  const jitter = Math.random() * 15000;
  return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
}

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveQueue(jobs) {
  writeFileSync(QUEUE_PATH, JSON.stringify(jobs, null, 2));
}

function loadAppliedIds() {
  if (!existsSync(HISTORY_PATH)) return new Set();
  const lines = readFileSync(HISTORY_PATH, 'utf-8').split('\n').slice(1);
  const ids = new Set();
  for (const line of lines) {
    const id = line.split('\t')[0];
    if (id) ids.add(id);
  }
  return ids;
}

function ensureHistoryFile() {
  if (!existsSync(HISTORY_PATH)) {
    writeFileSync(HISTORY_PATH, HISTORY_HEADER + '\n');
  }
}

function recordApply(job, status, notes = '') {
  const line = [
    job.jobId,
    job.url,
    job.title,
    job.company,
    job.matchScore || '',
    new Date().toISOString(),
    status,
    notes,
  ].join('\t');
  appendFileSync(HISTORY_PATH, line + '\n');
}

function getTodayApplyCount() {
  if (!existsSync(HISTORY_PATH)) return 0;
  const today = new Date().toISOString().split('T')[0];
  const lines = readFileSync(HISTORY_PATH, 'utf-8').split('\n').slice(1);
  return lines.filter(l => {
    if (!l.includes(today)) return false;
    const cols = l.split('\t');
    return cols[6] === 'applied';
  }).length;
}

// ── Apply to a single job ───────────────────────────────────────────

async function applyToJob(page, job, config, dryRun) {
  const applyConfig = config.auto_apply;

  log(`  📋 Opening: ${job.title} @ ${job.company}`);
  log(`     URL: ${job.url}`);
  log(`     Match: ${job.matchScore}%`);

  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(3000);

    // Check if redirected away from naukrigulf
    const currentUrl = page.url();
    if (!currentUrl.includes('naukrigulf.com')) {
      log(`     ⚠️  Redirected to external site. Skipping.`);
      return { status: 'skipped', reason: 'external_redirect' };
    }

    // Check for expired job
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '');
    if (bodyText.includes('no longer available') || bodyText.includes('expired') || bodyText.includes('Job not found')) {
      log(`     ⚠️  Job expired. Skipping.`);
      return { status: 'skipped', reason: 'expired' };
    }

    // Check already applied
    const alreadyText = bodyText.toLowerCase();
    if (alreadyText.includes('already applied') || alreadyText.includes('you have applied')) {
      log(`     ✅ Already applied. Skipping.`);
      return { status: 'skipped', reason: 'already_applied' };
    }

    // Find Apply button - NaukriGulf selectors
    const applySelectors = [
      'button[class*="apply"], button[id*="apply"]',
      'a[class*="apply"], a[id*="apply"]',
      'button:has-text("Apply")',
      'a:has-text("Apply Now")',
      'a:has-text("Easy Apply")',
      '[class*="applyBtn"]',
      '[class*="apply-button"]',
      '.apply-btn',
    ];

    let applyBtn = null;
    for (const sel of applySelectors) {
      applyBtn = await page.$(sel);
      if (applyBtn) {
        const visible = await applyBtn.isVisible().catch(() => false);
        if (visible) break;
        applyBtn = null;
      }
    }

    if (!applyBtn) {
      log(`     ⚠️  No Apply button found. Skipping.`);
      return { status: 'skipped', reason: 'no_apply_button' };
    }

    // Check if external apply
    const btnText = await applyBtn.textContent().catch(() => '');
    if (btnText.toLowerCase().includes('company site') || btnText.toLowerCase().includes('external')) {
      log(`     ⚠️  External apply. Skipping.`);
      return { status: 'skipped', reason: 'external_apply' };
    }

    if (dryRun) {
      log(`     🏁 [DRY-RUN] Would click Apply. Button text: "${btnText.trim()}"`);
      return { status: 'dry_run', reason: 'would_apply' };
    }

    // Click Apply
    await applyBtn.click();
    await randomDelay(3000);

    // Handle post-click flow (form fields, confirmation dialogs)
    // NaukriGulf may show a form with notice period, experience, etc.
    await handleApplicationForm(page, applyConfig);

    // Check for success indicators
    const success = await checkSuccess(page);
    if (success) {
      log(`     ✅ Application submitted successfully!`);
      return { status: 'applied', reason: 'success' };
    }

    // Look for Submit/Confirm button after form
    const submitSelectors = [
      'button:has-text("Submit")',
      'button:has-text("Confirm")',
      'button:has-text("Apply")',
      'button[type="submit"]',
      '[class*="submit"]',
    ];

    for (const sel of submitSelectors) {
      const submitBtn = await page.$(sel);
      if (submitBtn) {
        const visible = await submitBtn.isVisible().catch(() => false);
        if (visible) {
          await submitBtn.click();
          await randomDelay(3000);
          const finalSuccess = await checkSuccess(page);
          if (finalSuccess) {
            log(`     ✅ Application submitted successfully!`);
            return { status: 'applied', reason: 'success' };
          }
          break;
        }
      }
    }

    log(`     ⚠️  Apply clicked but success not confirmed.`);
    return { status: 'uncertain', reason: 'no_confirmation' };

  } catch (e) {
    log(`     ❌ Error: ${e.message}`);
    return { status: 'error', reason: e.message.substring(0, 100) };
  }
}

async function handleApplicationForm(page, applyConfig) {
  // Fill common form fields if present
  const fields = {
    'notice': applyConfig.notice_period || '15 Days',
    'current': applyConfig.current_ctc || '20',
    'expected': applyConfig.expected_ctc || '30',
  };

  // Try to fill notice period
  const noticeSel = await page.$('select[name*="notice"], select[id*="notice"], [class*="notice"] select');
  if (noticeSel) {
    try {
      await noticeSel.selectOption({ label: fields.notice });
    } catch {
      // Try typing instead
      try { await noticeSel.selectOption({ value: '15' }); } catch {}
    }
  }

  // Fill CTC fields (input type)
  const ctcInputs = await page.$$('input[name*="ctc"], input[name*="salary"], input[id*="ctc"]');
  for (const input of ctcInputs) {
    const name = await input.getAttribute('name') || await input.getAttribute('id') || '';
    if (name.includes('current') || name.includes('curr')) {
      await input.fill(fields.current);
    } else if (name.includes('expected') || name.includes('exp')) {
      await input.fill(fields.expected);
    }
  }

  await new Promise(r => setTimeout(r, 1000));
}

async function checkSuccess(page) {
  const successIndicators = [
    ':text("successfully")',
    ':text("application has been")',
    ':text("applied successfully")',
    ':text("Thank you")',
    '[class*="success"]',
    '[class*="applied-success"]',
  ];

  for (const sel of successIndicators) {
    const el = await page.$(sel);
    if (el) {
      const visible = await el.isVisible().catch(() => false);
      if (visible) return true;
    }
  }
  return false;
}

// ── Main execution ──────────────────────────────────────────────────

async function main() {
  const config = loadAgentConfig();
  const applyConfig = config.auto_apply;
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1]) : (applyConfig.daily_limit || 10);

  log('═══════════════════════════════════════════════');
  log('  🌍 Naukri Gulf Auto-Apply');
  log(`  📅 ${new Date().toISOString().split('T')[0]}`);
  log('═══════════════════════════════════════════════\n');

  // Wait for network
  try {
    await waitForNetwork();
  } catch (e) {
    log(`❌ ${e.message}`);
    process.exit(1);
  }

  ensureHistoryFile();

  // Check daily limit
  const todayCount = getTodayApplyCount();
  const remaining = Math.max(0, limit - todayCount);
  log(`📊 Today's applies: ${todayCount}/${limit}`);

  if (remaining === 0 && !dryRun) {
    log('✅ Daily limit reached. Done.');
    return;
  }

  // Load queue — filter to Gulf jobs only
  const queue = loadQueue();
  const appliedIds = loadAppliedIds();
  const gulfJobs = queue
    .filter(j => j.source === 'naukrigulf')
    .filter(j => !appliedIds.has(j.jobId))
    .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
    .slice(0, remaining);

  if (gulfJobs.length === 0) {
    log('📭 No Gulf jobs in queue to apply to.');
    return;
  }

  log(`📋 Processing ${gulfJobs.length} Gulf jobs...\n`);

  // Create session
  const session = await createNaukriGulfSession();
  const { context } = session;
  const page = context.pages()[0] || await context.newPage();

  // Verify session
  log('  🔑 Verifying Gulf session...');
  const valid = await verifyNaukriGulfSession(page);
  if (!valid) {
    log('  ❌ Session expired. Run: node naukrigulf-login.mjs');
    await closeNaukriGulfSession(session);
    process.exit(1);
  }
  log('  ✅ Session active\n');

  // Apply to each job
  const results = { applied: 0, skipped: 0, errors: 0 };
  const appliedJobs = [];

  for (let i = 0; i < gulfJobs.length; i++) {
    const job = gulfJobs[i];
    log(`\n── Job ${i + 1}/${gulfJobs.length} ──────────────────────────`);

    const result = await applyToJob(page, job, config, dryRun);

    if (result.status === 'applied') {
      results.applied++;
      appliedJobs.push(job);
      recordApply(job, 'applied', `gulf_${result.reason}`);
    } else if (result.status === 'error') {
      results.errors++;
      recordApply(job, 'error', result.reason);
    } else if (result.status !== 'dry_run') {
      results.skipped++;
      recordApply(job, result.status, result.reason);
    }

    // Delay between applications
    if (i < gulfJobs.length - 1) {
      const delay = applyConfig.delay_between_applies_ms || 45000;
      await randomDelay(delay);
    }
  }

  await closeNaukriGulfSession(session);

  // Summary
  log('\n═══════════════════════════════════════════════');
  log('  📊 Gulf Auto-Apply Summary');
  log('═══════════════════════════════════════════════');
  log(`  ✅ Applied: ${results.applied}`);
  log(`  ⏭️  Skipped: ${results.skipped}`);
  log(`  ❌ Errors: ${results.errors}`);
  log(`  📋 Total processed: ${gulfJobs.length}`);
  if (dryRun) log('  (dry-run mode — nothing submitted)');
  log('');

  // Send email report if any applies happened
  if (results.applied > 0 && !dryRun) {
    try {
      await sendAutoApplyReport({
        applied: results.applied,
        skipped: results.skipped,
        errors: results.errors,
        jobs: appliedJobs,
        platform: 'naukrigulf',
      });
      log('📧 Report email sent.');
    } catch (e) {
      log(`⚠️  Email failed: ${e.message}`);
    }
  }
}

main().catch(err => {
  log(`❌ Fatal error: ${err.message}`);
  process.exit(1);
});
