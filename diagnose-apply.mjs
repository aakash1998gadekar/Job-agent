/**
 * diagnose-apply.mjs — Inspect Naukri job page DOM to find correct selectors
 * for Apply and Submit buttons.
 * 
 * Usage: node diagnose-apply.mjs <job_url>
 */

import { chromium } from 'playwright';
import { existsSync } from 'fs';

const SESSION_DIR = 'data/naukri-session';
const url = process.argv[2];

if (!url) {
  console.error('Usage: node diagnose-apply.mjs <naukri_job_url>');
  process.exit(1);
}

async function main() {
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log('\n═══ PAGE TITLE ═══');
  console.log(await page.title());

  // Find all buttons on the page
  console.log('\n═══ ALL BUTTONS ═══');
  const buttons = await page.$$eval('button, a[role="button"], input[type="submit"]', els => 
    els.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).map(el => ({
      tag: el.tagName,
      text: el.textContent.trim().substring(0, 60),
      id: el.id,
      class: el.className.substring(0, 80),
      type: el.type || '',
    }))
  );
  buttons.forEach(b => console.log(`  [${b.tag}] id="${b.id}" class="${b.class}" text="${b.text}"`));

  // Specifically look for Apply-related elements
  console.log('\n═══ APPLY-RELATED ELEMENTS ═══');
  const applyEls = await page.$$eval('*', els =>
    els.filter(el => {
      const text = (el.textContent || '').toLowerCase();
      const cls = (el.className || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      return (text.includes('apply') || cls.includes('apply') || id.includes('apply')) &&
             el.tagName.match(/BUTTON|A|INPUT|DIV/) &&
             el.getBoundingClientRect().width > 0;
    }).slice(0, 20).map(el => ({
      tag: el.tagName,
      text: el.textContent.trim().substring(0, 80),
      id: el.id,
      class: (el.className || '').substring(0, 100),
      href: el.href || '',
    }))
  );
  applyEls.forEach(a => console.log(`  [${a.tag}] id="${a.id}" class="${a.class}" text="${a.text}" href="${a.href}"`));

  // Try clicking the first Apply-like button
  console.log('\n═══ ATTEMPTING APPLY CLICK ═══');
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

  let clicked = false;
  for (const sel of applySelectors) {
    const btn = await page.$(sel);
    if (btn) {
      const visible = await btn.isVisible().catch(() => false);
      if (visible) {
        const text = await btn.textContent().catch(() => '');
        console.log(`  Found: ${sel} => text="${text.trim()}"`);
        await btn.click();
        clicked = true;
        break;
      }
    }
  }

  if (!clicked) {
    console.log('  ❌ No Apply button found with standard selectors');
    // Try broader search
    const broader = await page.$('button:has-text("Apply"), a:has-text("Apply")');
    if (broader) {
      const text = await broader.textContent();
      console.log(`  Found with broader selector: "${text.trim()}"`);
    }
  } else {
    // Wait for form/modal
    await page.waitForTimeout(5000);
    
    console.log('\n═══ AFTER CLICK — MODAL/FORM ELEMENTS ═══');
    const formEls = await page.$$eval('[class*="chatbot"], [class*="drawer"], [class*="modal"], [class*="dialog"], [role="dialog"], [class*="apply"], [class*="Apply"]', els =>
      els.filter(el => el.getBoundingClientRect().width > 0).map(el => ({
        tag: el.tagName,
        id: el.id,
        class: (el.className || '').substring(0, 120),
        children: el.children.length,
      }))
    );
    formEls.forEach(f => console.log(`  [${f.tag}] id="${f.id}" class="${f.class}" (${f.children} children)`));

    // Find submit buttons in modal
    console.log('\n═══ SUBMIT BUTTONS IN MODAL ═══');
    const submitBtns = await page.$$eval('button, input[type="submit"]', els =>
      els.filter(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) return false;
        const text = (el.textContent || '').toLowerCase();
        const cls = (el.className || '').toLowerCase();
        return text.includes('submit') || text.includes('apply') || cls.includes('submit') || el.type === 'submit';
      }).map(el => ({
        tag: el.tagName,
        text: el.textContent.trim().substring(0, 60),
        id: el.id,
        class: (el.className || '').substring(0, 100),
        type: el.type,
        visible: el.getBoundingClientRect().width > 0,
      }))
    );
    submitBtns.forEach(s => console.log(`  [${s.tag}] id="${s.id}" class="${s.class}" text="${s.text}" type="${s.type}"`));

    // All visible buttons after click
    console.log('\n═══ ALL VISIBLE BUTTONS AFTER CLICK ═══');
    const allBtns = await page.$$eval('button', els =>
      els.filter(el => el.getBoundingClientRect().width > 0 && el.offsetParent !== null)
        .map(el => ({
          text: el.textContent.trim().substring(0, 60),
          id: el.id,
          class: (el.className || '').substring(0, 80),
        }))
    );
    allBtns.forEach(b => console.log(`  id="${b.id}" class="${b.class}" text="${b.text}"`));
  }

  // Keep browser open for manual inspection
  console.log('\n\n🔍 Browser left open for inspection. Press Ctrl+C to close.');
  await page.waitForTimeout(120000);
  await context.close();
}

main().catch(e => { console.error(e); process.exit(1); });
