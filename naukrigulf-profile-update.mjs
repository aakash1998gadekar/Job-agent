#!/usr/bin/env node

/**
 * naukrigulf-profile-update.mjs — Naukri Gulf profile activity toggler
 *
 * Updates the Naukri Gulf profile to trigger a "profile updated" timestamp,
 * boosting recruiter visibility. Strategy: toggle last letter of name
 * (delete → save → restore → save). Two saves = guaranteed activity signal.
 *
 * Usage:
 *   node naukrigulf-profile-update.mjs            # update profile
 *   node naukrigulf-profile-update.mjs --dry-run  # verify session, don't save
 */

import { loadAgentConfig } from './lib/config-loader.mjs';
import { createNaukriGulfSession, verifyNaukriGulfSession, closeNaukriGulfSession } from './lib/naukrigulf-session.mjs';
import { waitForNetwork } from './lib/wait-ready.mjs';

// ── Config ──────────────────────────────────────────────────────────

const DASHBOARD_URL = 'https://www.naukrigulf.com/jobseeker/profile';
const MYCV_URL = 'https://www.naukrigulf.com/mnj/userProfile/myCV?source=dashboard';

// ── Random delay (anti-detection) ───────────────────────────────────

function randomDelay(baseMs) {
  const jitter = Math.random() * 1000;
  return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
}

// ── Helper: Navigate to myCV page via dashboard link ────────────────

async function navigateToMyCV(page) {
  // First go to dashboard
  await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 45000 });
  await randomDelay(5000);

  // Click on "View & Update Profile" link
  const viewUpdateLink = await page.$('a[href*="myCV"]');
  if (viewUpdateLink) {
    await viewUpdateLink.click();
    await randomDelay(5000);
    return true;
  }

  // Fallback: direct navigation
  await page.goto(MYCV_URL, { waitUntil: 'networkidle', timeout: 45000 });
  await randomDelay(5000);
  return true;
}

// ── Helper: Click the name edit button ──────────────────────────────

async function clickNameEdit(page) {
  // NaukriGulf uses .edit-cta class for edit buttons on the myCV page
  // The first one is typically the name/personal details edit
  const editSelectors = [
    '.edit-cta',
    'a.edit-cta',
    '.ng-link.edit-cta',
    '[class*="edit-cta"]',
    'a:has-text("Edit")',
    'span:has-text("Edit")',
  ];

  for (const sel of editSelectors) {
    const btns = await page.$$(sel);
    if (btns.length > 0) {
      // Click the first visible edit button (personal/name section)
      for (const btn of btns) {
        const visible = await btn.isVisible().catch(() => false);
        if (visible) {
          await btn.click();
          return true;
        }
      }
    }
  }
  return false;
}

// ── Helper: Find name input field ───────────────────────────────────

async function findNameInput(page) {
  const inputSelectors = [
    'input[name*="name" i]',
    'input[id*="name" i]',
    'input[placeholder*="name" i]',
    'input[name*="fullName" i]',
    'input[id*="fullName" i]',
    'input[name*="firstName" i]',
    '#firstName',
    '#fullName',
    '#name',
  ];

  for (const sel of inputSelectors) {
    const input = await page.$(sel);
    if (input) {
      const visible = await input.isVisible().catch(() => false);
      if (visible) return input;
    }
  }
  return null;
}

// ── Helper: Click save button ───────────────────────────────────────

async function clickSave(page) {
  const saveSelectors = [
    'button:has-text("Save")',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Update")',
    '[class*="save-btn"]',
    '[class*="saveBtn"]',
    'button[class*="primary"]',
  ];

  for (const sel of saveSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      const visible = await btn.isVisible().catch(() => false);
      if (visible) {
        await btn.click();
        return true;
      }
    }
  }
  return false;
}

// ── Main update ─────────────────────────────────────────────────────

export async function updateNaukriGulfProfile(options = {}) {
  const config = loadAgentConfig();
  const dryRun = options.dryRun || process.argv.includes('--dry-run');
  const fullName = config.profile?.full_name || 'Aakash Gadekar';

  const status = {
    success: false,
    timestamp: new Date().toISOString(),
    error: null,
    platform: 'naukrigulf',
  };

  console.log('🔄 Naukri Gulf Profile Update (Name Letter Toggle)');
  console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  // Wait for internet
  if (!dryRun) {
    console.log('  ⏳ Waiting for network...');
    const online = await waitForNetwork();
    if (!online) {
      status.error = 'No internet after 300s';
      console.error('  ❌ No internet after 300s. Aborting.');
      return status;
    }
    console.log('  ✅ Network ready\n');
  }

  const session = await createNaukriGulfSession();
  const { context } = session;
  const page = context.pages()[0] || await context.newPage();

  try {
    // Step 1: Verify session
    console.log('  1️⃣  Verifying saved session...');
    const valid = await verifyNaukriGulfSession(page);
    if (!valid) {
      throw new Error(
        'Naukri Gulf session expired. Run: node naukrigulf-login.mjs (one-time browser login)'
      );
    }
    console.log('  ✅ Session active\n');

    // Step 2: Navigate to myCV (profile edit) page
    console.log('  2️⃣  Opening profile page...');
    await navigateToMyCV(page);

    // Step 3: Find the name edit section
    console.log('  3️⃣  Locating name edit...');
    const editClicked = await clickNameEdit(page);
    if (!editClicked) {
      throw new Error('Could not find name edit button on Naukri Gulf profile page');
    }
    await randomDelay(2000);

    // Step 4: Get the name input
    const nameInput = await findNameInput(page);
    if (!nameInput) {
      throw new Error('Could not find name input field');
    }

    const currentName = await nameInput.inputValue();
    console.log(`  📝 Current name: "${currentName}"`);
    console.log(`  📝 Canonical name: "${fullName}"`);

    if (dryRun) {
      console.log('  ⏸️  DRY RUN — would toggle last letter of name');
      status.success = true;
    } else {
      // Step 5: Remove last letter → Save
      const shortenedName = fullName.slice(0, -1);
      console.log(`  4️⃣  Shortening: "${fullName}" → "${shortenedName}"`);

      await nameInput.fill('');
      await randomDelay(300);
      await nameInput.fill(shortenedName);
      await randomDelay(800);

      await clickSave(page);
      await randomDelay(3000);
      console.log('  ✅ Saved without last letter');

      // Step 6: Navigate back and restore full name
      console.log('  5️⃣  Restoring full name...');
      await navigateToMyCV(page);

      let editOpened = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        editOpened = await clickNameEdit(page);
        if (editOpened) break;
        await randomDelay(2000);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(3000);
      }
      if (!editOpened) {
        throw new Error('Could not re-open name edit after save');
      }
      await randomDelay(3000);

      const nameInput2 = await findNameInput(page);
      if (!nameInput2) {
        await randomDelay(3000);
        const nameInput2Retry = await findNameInput(page);
        if (!nameInput2Retry) {
          throw new Error('Could not find name input on second edit');
        }
        await nameInput2Retry.fill('');
        await randomDelay(300);
        await nameInput2Retry.fill(fullName);
        await randomDelay(800);
      } else {
        await nameInput2.fill('');
        await randomDelay(300);
        await nameInput2.fill(fullName);
        await randomDelay(800);
      }

      await clickSave(page);
      await randomDelay(2000);
      console.log(`  ✅ Restored full name: "${fullName}"`);
      console.log('  🎉 Naukri Gulf profile updated (2 saves = activity signal)');

      status.success = true;
    }
  } catch (error) {
    status.error = error.message;
    console.error(`\n  ❌ Error: ${error.message}`);
  } finally {
    await closeNaukriGulfSession(session);
  }

  return status;
}

// ── CLI entrypoint ──────────────────────────────────────────────────

if (process.argv[1]?.endsWith('naukrigulf-profile-update.mjs')) {
  updateNaukriGulfProfile().then(status => {
    if (status.success) {
      console.log('\n✅ Done.');
    } else {
      console.error(`\n❌ Failed: ${status.error}`);
      process.exit(1);
    }
  }).catch(err => {
    console.error(`❌ Fatal: ${err.message}`);
    process.exit(1);
  });
}
