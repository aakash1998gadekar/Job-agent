#!/usr/bin/env node
import { chromium } from 'playwright';
import dotenv from 'dotenv';
dotenv.config({ path: '/Users/aakashgadekar/Downloads/career-ops-main/.env' });

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));

console.log('Filling #username...');
await page.locator('#username').fill(process.env.LINKEDIN_EMAIL);
await new Promise(r => setTimeout(r, 800));
console.log('Filling #password...');
await page.locator('#password').fill(process.env.LINKEDIN_PASSWORD);
await new Promise(r => setTimeout(r, 500));
console.log('Pressing Enter...');
await page.locator('#password').press('Enter');

await page.waitForURL(/\/(feed|checkpoint|jobs|in\/)/, { timeout: 20000 }).catch(() => null);
const url = page.url();
console.log('Current URL:', url);
const isLogin = url.includes('login');
const isCheckpoint = url.includes('checkpoint') || url.includes('challenge');
if (isCheckpoint) {
  console.log('⚠️  Checkpoint/CAPTCHA detected');
} else if (isLogin) {
  console.log('❌ Still on login page');
} else {
  console.log('✅ Login successful');
}

// Now test a search
if (!isLogin && !isCheckpoint) {
  console.log('\nTesting job search...');
  await page.goto('https://www.linkedin.com/jobs/search/?keywords=Security+Analyst&location=India&f_TPR=r604800&sortBy=DD', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise(r => setTimeout(r, 8000));
  
  // Scroll to load more
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 3000));
  
  const jobInfo = await page.evaluate(() => {
    const selectors = [
      '.jobs-search-results__list-item',
      '.job-card-container',
      '[data-job-id]',
      '.scaffold-layout__list-item',
      '.jobs-search-results-list__list-item',
      'li.ember-view.occludable-update',
    ];
    const results = {};
    for (const sel of selectors) {
      results[sel] = document.querySelectorAll(sel).length;
    }
    // Also get all links with /jobs/view/
    const jobLinks = [...document.querySelectorAll('a[href*="/jobs/view/"]')];
    results['a[href*="/jobs/view/"]'] = jobLinks.length;
    // Get first few job titles
    const titles = jobLinks.slice(0, 5).map(a => a.textContent.trim().split('\n')[0].trim()).filter(Boolean);
    results.sampleTitles = titles;
    return results;
  });
  console.log('Job search results:', JSON.stringify(jobInfo, null, 2));
}

await browser.close();
