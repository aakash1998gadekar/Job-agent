#!/usr/bin/env node

/**
 * auto-apply-naukri.mjs — Automated Naukri job application engine
 *
 * Reads the to-apply queue (data/to-apply.json), applies to top N jobs
 * matching the threshold, fills standard form fields (notice period, CTC),
 * and tracks results in data/apply-history.tsv.
 *
 * Usage:
 *   node auto-apply-naukri.mjs              # apply to top jobs from queue
 *   node auto-apply-naukri.mjs --dry-run    # detect apply buttons, don't submit
 *   node auto-apply-naukri.mjs --limit 1    # apply to just 1 job (test)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { loadAgentConfig } from './lib/config-loader.mjs';
import { createNaukriSession, verifySession, closeSession } from './lib/naukri-session.mjs';
import { getReorderedSkills } from './lib/skills-reorder.mjs';
import { waitForNetwork } from './lib/wait-ready.mjs';
import { sendAutoApplyReport } from './lib/email-notify.mjs';

// ── Config ──────────────────────────────────────────────────────────

const QUEUE_PATH = 'data/to-apply.json';
const HISTORY_PATH = 'data/apply-history.tsv';
const HISTORY_HEADER = 'jobId\turl\ttitle\tcompany\tmatchScore\tappliedAt\tstatus\tnotes';
const LOG_PATH = 'logs/auto-apply.log';
const SCREENING_Q_PATH = 'data/screening-questions.json';
const RESUME_PDF = 'Resume (1).pdf';

mkdirSync('data', { recursive: true });
mkdirSync('logs', { recursive: true });

// ── Helpers ─────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

function randomDelay(baseMs) {
  const jitter = Math.random() * 15000; // 0-15s jitter
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

function logScreeningQuestion(job, fields) {
  let existing = [];
  try {
    if (existsSync(SCREENING_Q_PATH)) existing = JSON.parse(readFileSync(SCREENING_Q_PATH, 'utf-8'));
  } catch {}
  existing.push({
    jobId: job.jobId,
    title: job.title,
    company: job.company,
    url: job.url,
    detectedAt: new Date().toISOString(),
    fields: fields,
  });
  writeFileSync(SCREENING_Q_PATH, JSON.stringify(existing, null, 2));
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
    return cols[6] === 'applied'; // status column (not notes)
  }).length;
}

// ── Apply to a single job ───────────────────────────────────────────

async function applyToJob(page, job, config, dryRun) {
  const applyConfig = config.auto_apply;

  log(`  📋 Opening: ${job.title} @ ${job.company}`);
  log(`     URL: ${job.url}`);
  log(`     Match: ${job.matchScore}%`);

  try {
    // Navigate to job page
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(3000);

    // Check if we're still on Naukri (not redirected to external site)
    const currentUrl = page.url();
    if (!currentUrl.includes('naukri.com')) {
      log(`     ⚠️  Redirected to external site. Skipping.`);
      return { status: 'skipped', reason: 'external_redirect' };
    }

    // Check if job has expired (redirected to search page or shows expired message)
    const pageTitle = await page.title();
    if (pageTitle.includes('Job Vacancies') || pageTitle.includes('Jobs In')) {
      log(`     ⚠️  Job expired (redirected to search). Skipping.`);
      return { status: 'skipped', reason: 'expired' };
    }
    const expiredEl = await page.$('[class*="exp-alert-message"], [class*="expired"], :text("Job you are looking for is expired")');
    if (expiredEl) {
      log(`     ⚠️  Job expired. Skipping.`);
      return { status: 'skipped', reason: 'expired' };
    }

    // Check if it's "Apply on company site" (external)
    const companySiteBtn = await page.$('#company-site-button');
    if (companySiteBtn) {
      log(`     ⚠️  External apply (company site). Skipping.`);
      return { status: 'skipped', reason: 'external_apply' };
    }

    // Check for "Already Applied" indicator
    const alreadyApplied = await page.$('[class*="already-applied"], .already-applied, [class*="Applied"]');
    if (alreadyApplied) {
      const text = await alreadyApplied.textContent().catch(() => '');
      if (text.toLowerCase().includes('applied')) {
        log(`     ✅ Already applied. Skipping.`);
        return { status: 'skipped', reason: 'already_applied' };
      }
    }

    // Find the Apply button — try multiple selectors
    const applySelectors = [
      'button#apply-button',
      'button.apply-button',
      '[class*="apply-btn"]',
      'button:has-text("Apply")',
      'a:has-text("Apply on company site")',
      '[class*="applyButton"]',
      'button[class*="chatbot-apply"]',
      '#apply-button',
      '.styles_jhc__apply-button-container button',
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

    // Check if it's an external apply link
    const btnText = await applyBtn.textContent().catch(() => '');
    if (btnText.toLowerCase().includes('company site') || btnText.toLowerCase().includes('external')) {
      log(`     ⚠️  External apply link. Skipping.`);
      return { status: 'skipped', reason: 'external_apply' };
    }

    if (dryRun) {
      log(`     ⏸️  DRY RUN — would click Apply button`);
      return { status: 'dry_run', reason: 'would_apply' };
    }

    // Click Apply
    log(`     🖱️  Clicking Apply...`);
    await applyBtn.click();
    await randomDelay(3000);

    // Handle the apply modal/form
    const applied = await handleApplyForm(page, applyConfig, job);
    return applied;

  } catch (err) {
    log(`     ❌ Error: ${err.message}`);
    return { status: 'error', reason: err.message };
  }
}

// ── Handle the Apply modal form ─────────────────────────────────────

async function handleApplyForm(page, applyConfig, job) {
  // Wait for chatbot drawer or modal to appear
  try {
    await page.waitForSelector(
      '[class*="chatbot_Drawer"], [class*="apply-modal"], [role="dialog"], [class*="ApplyForm"], [class*="chatBotContainer"]',
      { timeout: 8000 }
    );
  } catch (_) {
    // No modal appeared — might be Easy Apply or already submitted
  }

  // Wait for chatbot footer/submit area to fully load (takes extra time)
  try {
    await page.waitForSelector(
      '.chatbot_DrawerFooter, [class*="chatbot"] button, [class*="chatbot_Footer"], [class*="chatbot_Input"]',
      { timeout: 12000 }
    );
  } catch (_) {
    // Footer may not appear if it's 1-click or already submitted
  }
  await randomDelay(2000);

  // Check if application was submitted immediately (Easy Apply / 1-click)
  // Also check chatbot messages for success confirmation
  const successCheck = async () => {
    // Check standard indicators
    const successIndicators = [
      '[class*="success"]',
      '[class*="congratulations"]',
      ':text("applied successfully")',
      ':text("Application Submitted")',
      '[class*="applied-msg"]',
      '.chatbot_MessageContainer :text("successfully")',
      '.chatbot_MessageContainer :text("submitted")',
      '.apply-status-header.green',
      '.apply-message',
    ];
    for (const sel of successIndicators) {
      const success = await page.$(sel);
      if (success) return true;
    }
    // Check chatbot message text for success keywords
    const chatText = await page.$eval('.chatbot_MessageContainer, .chatbot_DrawerContentWrapper', 
      el => el?.textContent?.toLowerCase() || ''
    ).catch(() => '');
    if (chatText.includes('successfully') || chatText.includes('submitted') || chatText.includes('application has been')) {
      return true;
    }
    return false;
  };

  if (await successCheck()) {
    log(`     🎉 Applied successfully (Easy Apply / 1-click)!`);
    return { status: 'applied', reason: 'easy_apply' };
  }

  // Look for form fields to fill
  // Notice Period
  const noticePeriodSelectors = [
    'select[name*="notice" i]',
    '[class*="notice"] select',
    'select[id*="notice" i]',
    'input[name*="notice" i]',
    'input[placeholder*="notice" i]',
    // Naukri chatbot style
    '.chatbot_DrawerBody select',
    '[class*="formRow"] select',
  ];

  for (const sel of noticePeriodSelectors) {
    const el = await page.$(sel);
    if (el) {
      const tagName = await el.evaluate(e => e.tagName.toLowerCase());
      if (tagName === 'select') {
        // Try to select "15 Days" option
        await el.selectOption({ label: applyConfig.notice_period }).catch(() =>
          el.selectOption({ value: '15' }).catch(() =>
            el.selectOption({ index: 1 }).catch(() => {})
          )
        );
      } else {
        await el.fill(applyConfig.notice_period);
      }
      log(`     📝 Filled notice period: ${applyConfig.notice_period}`);
      await randomDelay(500);
      break;
    }
  }

  // Current CTC
  const currentCtcSelectors = [
    'input[name*="current" i][name*="ctc" i]',
    'input[name*="currentCtc" i]',
    'input[placeholder*="current" i]',
    'input[id*="currentCtc" i]',
    '[class*="current-ctc"] input',
    'input[name*="currentSalary" i]',
    // Naukri chatbot generic input patterns
    'input[placeholder*="lakh" i]',
    'input[placeholder*="CTC" i]',
  ];

  for (const sel of currentCtcSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill('');
      await el.fill(applyConfig.current_ctc);
      log(`     📝 Filled current CTC: ${applyConfig.current_ctc} LPA`);
      await randomDelay(500);
      break;
    }
  }

  // Expected CTC
  const expectedCtcSelectors = [
    'input[name*="expected" i][name*="ctc" i]',
    'input[name*="expectedCtc" i]',
    'input[placeholder*="expected" i]',
    'input[id*="expectedCtc" i]',
    '[class*="expected-ctc"] input',
    'input[name*="expectedSalary" i]',
  ];

  for (const sel of expectedCtcSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill('');
      await el.fill(applyConfig.expected_ctc);
      log(`     📝 Filled expected CTC: ${applyConfig.expected_ctc} LPA`);
      await randomDelay(500);
      break;
    }
  }

  // Check for screening questions (text inputs we can't auto-fill)
  if (applyConfig.skip_screening_questions) {
    // Only check INSIDE the apply modal/drawer — ignore page-level search bars
    const remainingInputs = await page.evaluate(() => {
      // Look for the apply modal/drawer container
      const modal = document.querySelector(
        '[class*="chatbot"], [class*="apply-modal"], [class*="applyModal"], ' +
        '[class*="drawer"], [role="dialog"], [class*="apply-form"], ' +
        '.styles_jhc__chatbot-drawer, [class*="ApplyForm"]'
      );
      const container = modal || document.body;

      const inputs = container.querySelectorAll('input[type="text"], textarea');
      return Array.from(inputs)
        .filter(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          // Skip Naukri search bar fields (always present on page)
          const placeholder = (el.placeholder || '').toLowerCase();
          const name = (el.name || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          const combined = name + placeholder + id;
          // Skip standard fields we handle
          if (combined.match(/ctc|salary|notice|current|expected|resume|name|email|phone|mobile/)) return false;
          // Skip Naukri search/filter bar
          if (combined.match(/keyword|designation|companies|location|experience|search|suggest/)) return false;
          // Skip if already has a value
          if (el.value && el.value.trim().length > 0) return false;
          // Skip if it's inside a header/nav/search component
          const parent = el.closest('header, nav, [class*="search"], [class*="header"], [class*="naukFilter"], [class*="quickSearch"]');
          if (parent) return false;
          return true;
        })
        .map(el => ({
          name: el.name,
          placeholder: el.placeholder,
          id: el.id,
          type: el.tagName.toLowerCase(),
        }));
    });

    if (remainingInputs.length > 0) {
      log(`     ⚠️  Screening questions detected (${remainingInputs.length} unfilled fields: ${remainingInputs.map(i => i.placeholder || i.name || 'unknown').join(', ')}). Skipping.`);
      // Log screening questions for future automation
      logScreeningQuestion(job, remainingInputs);
      // Close the modal
      const closeBtn = await page.$('button[class*="close"], [class*="modal-close"], button:has-text("Cancel"), [class*="crossIcon"]');
      if (closeBtn) await closeBtn.click();
      return { status: 'skipped', reason: 'screening_questions' };
    }
  }

  // Dismiss any overlay that might block visibility checks
  await page.evaluate(() => {
    const overlays = document.querySelectorAll('[class*="Overlay"][class*="show"], [class*="overlay"].show');
    overlays.forEach(o => o.remove());
  });

  // Find and click Submit/Apply button in the form
  const submitSelectors = [
    '.chatbot_DrawerFooter button',
    'button.chatbot_SubmitBtn',
    '[class*="chatbot"] button[class*="submit" i]',
    '[class*="chatbot"] button:has-text("Apply")',
    '[class*="chatbot"] button:has-text("Submit")',
    '[class*="chatbot_Drawer"] button',
    '[class*="apply-modal"] button:has-text("Submit")',
    '[class*="apply-modal"] button:has-text("Apply")',
    '[role="dialog"] button:has-text("Submit")',
    '[role="dialog"] button:has-text("Apply")',
    'button[type="submit"]:not(#apply-button)',
    'input[type="submit"]',
    'button[class*="submit" i]:not(#apply-button)',
  ];

  let submitBtn = null;
  for (const sel of submitSelectors) {
    submitBtn = await page.$(sel);
    if (submitBtn) {
      const visible = await submitBtn.isVisible().catch(() => false);
      if (visible) break;
      submitBtn = null;
    }
  }

  if (!submitBtn) {
    // Debug: log what's inside the chatbot drawer
    const chatbotInfo = await page.evaluate(() => {
      const drawer = document.querySelector('[class*="chatbot_Drawer"], [class*="chatbot"]');
      if (!drawer) return { found: false };
      const buttons = Array.from(drawer.querySelectorAll('button, input[type="submit"]'))
        .map(b => ({ text: b.textContent?.trim().substring(0, 50), class: b.className?.substring(0, 60), visible: b.offsetParent !== null }));
      const inputs = Array.from(drawer.querySelectorAll('input, select, textarea'))
        .map(i => ({ tag: i.tagName, type: i.type, placeholder: i.placeholder, class: i.className?.substring(0, 60), visible: i.offsetParent !== null }));
      const messages = drawer.querySelector('[class*="MessageContainer"]')?.textContent?.substring(0, 200) || '';
      return { found: true, buttons, inputs, messages };
    }).catch(() => ({ found: false }));
    log(`     🔍 Chatbot debug: ${JSON.stringify(chatbotInfo)}`);
    log(`     ⚠️  No Submit button found in form. Skipping.`);
    return { status: 'skipped', reason: 'no_submit_button' };
  }

  // Click Submit
  log(`     🚀 Submitting application...`);
  await submitBtn.click({ force: true });
  await randomDelay(3000);

  // Verify success
  if (await successCheck()) {
    log(`     🎉 Applied successfully!`);
    return { status: 'applied', reason: 'form_submitted' };
  }

  // Check if URL changed or if we're back on the job page (usually means success)
  const postUrl = page.url();
  if (postUrl !== page.url()) {
    log(`     🎉 Applied (page redirected)!`);
    return { status: 'applied', reason: 'redirect_after_submit' };
  }

  // If no clear success signal, assume it worked (Naukri doesn't always show confirmation)
  log(`     ✅ Application submitted (no error detected)`);
  return { status: 'applied', reason: 'no_error_detected' };
}

// ── Update Naukri Key Skills ────────────────────────────────────────

async function updateNaukriKeySkills(page, skills) {
  log(`\n🔧 Updating Naukri Key Skills (top ${skills.length} skills for this batch)...`);

  try {
    await page.goto('https://www.naukri.com/mnjuser/profile', {
      waitUntil: 'load',
      timeout: 60000,
    });
    await randomDelay(5000);

    // Click the Key Skills edit icon (inside the widgetHead that says "Key skills")
    const clicked = await page.evaluate(() => {
      const headers = document.querySelectorAll('.widgetHead');
      for (const h of headers) {
        if (h.textContent.includes('Key skills')) {
          const edit = h.querySelector('span.edit, .edit.icon');
          if (edit) { edit.click(); return true; }
        }
      }
      return false;
    });

    if (!clicked) {
      log(`  ⚠️  Could not find Key Skills edit button. Skipping skills update.`);
      return false;
    }

    // Wait for the skills input to appear in the drawer
    try {
      await page.waitForSelector('#keySkillSugg', { timeout: 10000 });
    } catch {
      log(`  ⚠️  Key Skills edit drawer did not open. Skipping.`);
      return false;
    }
    await randomDelay(2000);

    // Remove all existing chips (click Cross on each)
    let removed = 0;
    for (let i = 0; i < 30; i++) {
      const crossBtn = await page.$('.keySkillsEdit.model_open .chipsContainer .chip a.close');
      if (!crossBtn) break;
      await crossBtn.click();
      await randomDelay(300);
      removed++;
    }
    log(`  🗑️  Removed ${removed} existing skills`);

    // Add new skills one by one via the suggestor input
    const skillInput = await page.$('#keySkillSugg');
    if (!skillInput) {
      log(`  ⚠️  Could not find skills input field. Skipping.`);
      return false;
    }

    let added = 0;
    for (const skill of skills.slice(0, 20)) {
      await skillInput.fill('');
      await skillInput.fill(skill);
      await randomDelay(800);
      // Wait for suggestion dropdown and press Enter to select
      await skillInput.press('Enter');
      await randomDelay(500);
      added++;
    }
    log(`  ✅ Added ${added} skills`);

    // Click Save
    const saveBtn = await page.$('button#saveKeySkills');
    if (saveBtn) {
      await saveBtn.click();
      await randomDelay(3000);
      log(`  ✅ Key Skills saved successfully`);
      return true;
    }

    log(`  ⚠️  Could not find Save button for skills. Skipping.`);
    return false;
  } catch (err) {
    log(`  ⚠️  Skills update error: ${err.message}`);
    return false;
  }
}

// ── Upload PDF Resume to Naukri Profile ─────────────────────────────

async function uploadResumeToNaukri(page, resumePath) {
  log(`\n📄 Uploading resume PDF to Naukri profile...`);

  try {
    const absPath = resolve(resumePath);
    if (!existsSync(absPath)) {
      log(`  ⚠️  Resume file not found: ${absPath}. Skipping upload.`);
      return false;
    }

    // Navigate to profile if not already there
    const currentUrl = page.url();
    if (!currentUrl.includes('mnjuser/profile')) {
      await page.goto('https://www.naukri.com/mnjuser/profile', {
        waitUntil: 'load',
        timeout: 60000,
      });
      await randomDelay(5000);
    }

    // Check current resume name
    const currentResume = await page.evaluate(() => {
      const nameEl = document.querySelector('.resume-name-inline');
      return nameEl?.textContent?.trim() || '';
    });
    log(`  📋 Current resume: ${currentResume || 'none'}`);

    // Upload the new PDF via the hidden file input
    const fileInput = await page.$('input#attachCV[type="file"]');
    if (!fileInput) {
      log(`  ⚠️  Resume upload input not found. Skipping.`);
      return false;
    }

    await fileInput.setInputFiles(absPath);
    await randomDelay(8000);

    // Check if confirmation dialog appeared ("Sure you want to replace...")
    const confirmBtn = await page.$('.res360editconfirmationBox a.btn-dark-ot');
    if (confirmBtn) {
      const isVisible = await confirmBtn.isVisible().catch(() => false);
      if (isVisible) {
        await confirmBtn.click();
        await randomDelay(5000);
      }
    }

    // Verify upload
    const newResume = await page.evaluate(() => {
      const nameEl = document.querySelector('.resume-name-inline');
      return nameEl?.textContent?.trim() || '';
    });
    log(`  ✅ Resume uploaded: ${newResume}`);
    return true;
  } catch (err) {
    log(`  ⚠️  Resume upload error: ${err.message}`);
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.indexOf('--limit');
  const customLimit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1]) : null;

  log(`\n${'═'.repeat(50)}`);
  log(`  🤖 Career-Ops Auto-Apply (Naukri)`);
  log(`  📅 ${new Date().toISOString().split('T')[0]}`);
  log(`  Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  log(`${'═'.repeat(50)}\n`);

  // Wait for network
  if (!dryRun) {
    log('⏳ Waiting for network...');
    const online = await waitForNetwork();
    if (!online) {
      log('❌ No internet after 300s. Aborting.');
      process.exit(1);
    }
    log('✅ Network ready\n');
  }

  // Load config
  const config = loadAgentConfig();
  const applyConfig = config.auto_apply;

  if (!applyConfig || !applyConfig.enabled) {
    log('⚠️  Auto-apply is disabled in config/profile.yml. Set agents.auto_apply.enabled: true');
    process.exit(0);
  }

  const dailyLimit = customLimit || applyConfig.daily_limit || 10;
  const minScore = applyConfig.min_match_score || 50;

  // Check today's apply count
  ensureHistoryFile();
  const todayCount = getTodayApplyCount();
  if (todayCount >= dailyLimit && !dryRun) {
    log(`📊 Already applied to ${todayCount} jobs today (limit: ${dailyLimit}). Done.`);
    process.exit(0);
  }

  const remaining = dailyLimit - todayCount;
  log(`📊 Today's applies: ${todayCount}/${dailyLimit} — will apply to up to ${remaining} more\n`);

  // Load queue
  const queue = loadQueue();
  if (queue.length === 0) {
    log('📭 No jobs in queue (data/to-apply.json). Run job-digest.mjs first.');
    process.exit(0);
  }

  // Filter: >= min score, not already applied, sorted by highest score first
  const appliedIds = loadAppliedIds();
  const eligible = queue
    .filter(j => (j.matchScore || 0) >= minScore)
    .filter(j => !appliedIds.has(j.jobId))
    .filter(j => j.source === 'naukri') // Naukri only for now
    .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
    .slice(0, remaining);

  if (eligible.length === 0) {
    log(`📭 No eligible jobs in queue (min score: ${minScore}%, not already applied, Naukri only).`);
    process.exit(0);
  }

  log(`🎯 ${eligible.length} jobs eligible for auto-apply (score ≥ ${minScore}%)\n`);

  // Start session
  const session = await createNaukriSession();
  const { context } = session;
  const page = context.pages()[0] || await context.newPage();

  try {
    // Verify session
    log('🔑 Verifying Naukri session...');
    const valid = await verifySession(page);
    if (!valid) {
      log('❌ Naukri session expired. Run: node naukri-login.mjs');
      process.exit(1);
    }
    log('✅ Session active\n');

    // Reorder Key Skills for this batch (optional, non-blocking, 90s timeout)
    if (!dryRun) {
      const reorderedSkills = getReorderedSkills(eligible);
      try {
        await Promise.race([
          updateNaukriKeySkills(page, reorderedSkills),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Skills update timed out after 90s')), 90000))
        ]);
      } catch (e) {
        log(`  ⚠️  ${e.message}. Continuing with applications...`);
      }
    }

    // Upload PDF resume to profile (ensures latest resume is used)
    if (!dryRun && existsSync(RESUME_PDF)) {
      await uploadResumeToNaukri(page, RESUME_PDF);
    }

    // Apply to each job
    const results = [];
    for (let i = 0; i < eligible.length; i++) {
      const job = eligible[i];
      log(`\n── Job ${i + 1}/${eligible.length} ──────────────────────────────`);

      const result = await applyToJob(page, job, config, dryRun);
      results.push({ ...job, ...result });

      // Record result
      if (!dryRun) {
        recordApply(job, result.status, result.reason);
      }

      // Delay between applications (anti-detection) — short delay for skips, full delay for applies
      if (i < eligible.length - 1) {
        const isSkip = result.status === 'skipped';
        const delay = isSkip ? 5000 : (applyConfig.delay_between_applies_ms || 45000);
        log(`  ⏳ Waiting ${Math.round(delay / 1000)}s before next...`);
        await randomDelay(delay);
      }
    }

    // Summary
    const applied = results.filter(r => r.status === 'applied').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;
    const dryRuns = results.filter(r => r.status === 'dry_run').length;

    log(`\n${'═'.repeat(50)}`);
    log(`  📊 Auto-Apply Summary`);
    log(`${'═'.repeat(50)}`);
    log(`  ✅ Applied: ${applied}`);
    log(`  ⏭️  Skipped: ${skipped}`);
    log(`  ❌ Errors: ${errors}`);
    if (dryRun) log(`  ⏸️  Dry run: ${dryRuns}`);
    log(`  📊 Total today: ${todayCount + applied}/${dailyLimit}`);

    // Remove applied/skipped jobs from queue
    if (!dryRun) {
      const processedIds = new Set(results.map(r => r.jobId));
      const updatedQueue = queue.filter(j => !processedIds.has(j.jobId));
      saveQueue(updatedQueue);
      log(`  📋 Queue updated: ${updatedQueue.length} jobs remaining`);
    }

    // Send email report
    if (!dryRun && applied > 0 && config.email) {
      try {
        await sendAutoApplyReport(results.filter(r => r.status === 'applied'), config.email);
        log(`  ✉️  Apply report email sent`);
      } catch (e) {
        log(`  ⚠️  Email failed: ${e.message}`);
      }
    }

  } finally {
    await closeSession(session);
  }
}

main().catch(err => {
  log(`\n💥 Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
