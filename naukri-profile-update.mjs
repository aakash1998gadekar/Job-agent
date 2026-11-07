#!/usr/bin/env node

/**
 * naukri-profile-update.mjs — Naukri profile activity toggler
 *
 * Updates the Naukri profile to trigger a "profile updated" timestamp,
 * boosting recruiter visibility. Strategy: delete last letter of name → save → 
 * add it back → save. Two saves = guaranteed activity signal.
 *
 * Usage:
 *   node naukri-profile-update.mjs            # update profile
 *   node naukri-profile-update.mjs --dry-run  # verify session, don't save
 */

import { loadAgentConfig } from './lib/config-loader.mjs';
import { sendProfileUpdateConfirmation } from './lib/email-notify.mjs';
import { createNaukriSession, verifySession, closeSession } from './lib/naukri-session.mjs';
import { waitForNetwork } from './lib/wait-ready.mjs';

// ── Config ──────────────────────────────────────────────────────────

const PROFILE_URL = 'https://www.naukri.com/mnjuser/profile';

// ── Random delay (anti-detection) ───────────────────────────────────

function randomDelay(baseMs) {
  const jitter = Math.random() * 1000;
  return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
}

// ── Main update ─────────────────────────────────────────────────────

export async function updateNaukriProfile(options = {}) {
  const config = loadAgentConfig();
  const dryRun = options.dryRun || process.argv.includes('--dry-run');

  // Always use the canonical full name from profile config
  const fullName = config.profile?.full_name || 'Aakash Gadekar';

  const status = {
    success: false,
    timestamp: new Date().toISOString(),
    error: null,
  };

  console.log('🔄 Naukri Profile Update (Name Letter Toggle)');
  console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  // Wait for internet (handles sleep/wake where WiFi isn't ready yet)
  if (!dryRun) {
    console.log('  ⏳ Waiting for network...');
    const online = await waitForNetwork();
    if (!online) {
      status.error = 'No internet after 300s';
      console.error('  ❌ No internet after 300s. Aborting.');
      if (!dryRun && config.email.to && config.email.app_password) {
        try { await sendProfileUpdateConfirmation(status, config.email); } catch {}
      }
      return status;
    }
    console.log('  ✅ Network ready\n');
  }

  const session = await createNaukriSession();
  const { context } = session;
  const page = context.pages()[0] || await context.newPage();

  try {
    // Step 1: Verify session
    console.log('  1️⃣  Verifying saved session...');
    const valid = await verifySession(page);
    if (!valid) {
      throw new Error(
        'Naukri session expired. Run: node naukri-login.mjs (one-time browser login)'
      );
    }
    console.log('  ✅ Session active\n');

    // Step 2: Navigate to profile
    console.log('  2️⃣  Opening profile page...');
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(3000);

    // Step 3: Find the name/personal details edit section
    console.log('  3️⃣  Locating name edit...');

    // Click on name section edit (pencil icon near the name)
    const editClicked = await clickNameEdit(page);
    if (!editClicked) {
      throw new Error('Could not find name edit button on profile page');
    }
    await randomDelay(2000);

    // Step 4: Get the name input and current value
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
      // Step 5: Remove last letter from FULL canonical name → Save
      const shortenedName = fullName.slice(0, -1);
      console.log(`  4️⃣  Shortening: "${fullName}" → "${shortenedName}"`);
      
      await nameInput.fill('');
      await randomDelay(300);
      await nameInput.fill(shortenedName);
      await randomDelay(800);

      await clickSave(page);
      await randomDelay(3000);
      console.log('  ✅ Saved without last letter');

      // Step 6: Navigate back to profile and re-edit
      console.log('  5️⃣  Restoring full name...');
      await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await randomDelay(5000);

      // Re-open edit (retry up to 3 times)
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
        // Wait a bit more and retry
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
        // Restore full name
        await nameInput2.fill('');
        await randomDelay(300);
        await nameInput2.fill(fullName);
        await randomDelay(800);
      }

      await clickSave(page);
      await randomDelay(2000);
      console.log(`  ✅ Restored full name: "${fullName}"`);
      console.log('  🎉 Profile updated successfully (2 saves = activity signal)');

      status.success = true;
    }
  } catch (error) {
    status.error = error.message;
    console.error(`\n  ❌ Error: ${error.message}`);
  } finally {
    await closeSession(session);
  }

  // Send notification email
  if (!dryRun && config.email.to && config.email.app_password) {
    try {
      await sendProfileUpdateConfirmation(status, config.email);
    } catch (emailErr) {
      console.error(`  ⚠️  Email notification failed: ${emailErr.message}`);
    }
  }

  console.log(`\n📊 Result: ${status.success ? 'SUCCESS' : 'FAILED'}`);
  console.log(`   Timestamp: ${status.timestamp}`);

  return status;
}

// ── Helper: Click the name edit button ──────────────────────────────

async function clickNameEdit(page) {
  // Try multiple selectors for the edit button near the name
  const selectors = [
    // Personal details edit icon (most common)
    '[class*="personalDetail"] [class*="edit"]',
    '[class*="BasicDetail"] [class*="edit"]',
    '.widgetHead.personalDetailHead [class*="edit"]',
    // Generic: first edit icon on profile (usually name section)
    '.edit-icon',
    'span[class*="icon-edit"]',
    // Fallback: look for edit near the username text
    '[class*="name"] ~ [class*="edit"]',
  ];

  for (const selector of selectors) {
    const btn = await page.$(selector);
    if (btn) {
      await btn.click();
      return true;
    }
  }

  // Last resort: try clicking pencil icon near top of profile
  const editIcons = await page.$$('[class*="edit"], .editIcon, svg[class*="edit"]');
  if (editIcons.length > 0) {
    await editIcons[0].click();
    return true;
  }

  return false;
}

// ── Helper: Find the name input field ───────────────────────────────

async function findNameInput(page) {
  const selectors = [
    'input[name="name"]',
    'input[placeholder*="name" i]',
    'input[id*="name" i]',
    'input[class*="name" i]',
    // Naukri specific: first text input in the edit form
    'form input[type="text"]:first-of-type',
    '.formWrapper input[type="text"]',
    'input[type="text"]',
  ];

  for (const sel of selectors) {
    const input = await page.$(sel);
    if (input) {
      const value = await input.inputValue();
      // Verify it looks like a name (has letters, not too long)
      if (value && value.length > 2 && value.length < 50 && /[a-zA-Z]/.test(value)) {
        return input;
      }
    }
  }
  return null;
}

// ── Helper: Click save button ───────────────────────────────────────

async function clickSave(page) {
  const selectors = [
    '#saveBasicDetailsBtn',
    'button.btn-dark-ot',
    'button:has-text("Save")',
    'button[class*="save" i]',
    'input[type="submit"][value*="Save" i]',
    'button[type="submit"]',
  ];

  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn && await btn.isVisible()) {
      await btn.click();
      return true;
    }
  }

  throw new Error('Could not find Save button');
}

// ── CLI entrypoint ──────────────────────────────────────────────────

if (process.argv[1]?.endsWith('naukri-profile-update.mjs')) {
  updateNaukriProfile().then(status => {
    process.exit(status.success ? 0 : 1);
  }).catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
  });
}
