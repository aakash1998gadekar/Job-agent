import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1366, height: 768 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});
const page = await context.newPage();

await page.goto('https://www.naukri.com/ai-engineer-jobs-in-bangalore?experience=5-10&sortBy=date', { waitUntil: 'networkidle', timeout: 30000 });
await new Promise(r => setTimeout(r, 5000));

const debug = await page.evaluate(() => {
  const selectors = [
    '.srp-jobtuple-wrapper',
    'article.jobTuple',
    '.cust-job-tuple',
    '[class*="tuple"]',
    '[class*="jobCard"]',
    '[class*="job-card"]',
    '[class*="JobCard"]',
    '.list-container > div',
    '[data-job-id]',
    'a[href*="job-listings"]',
    '.styles_jlc__main',
    '.styles_job-listing-container',
  ];

  const results = {};
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      results[sel] = els.length;
    }
  }

  // Get title of page
  results._title = document.title;
  results._url = window.location.href;

  // Get body text snippet
  results._bodySnippet = document.body.innerText.substring(0, 500);

  // Get first few links that look like job listings
  const allLinks = [...document.querySelectorAll('a[href*="job-listings"], a[href*="/job/"]')];
  results._jobLinks = allLinks.slice(0, 5).map(a => ({ text: a.textContent?.trim().substring(0, 60), href: a.href }));

  return results;
});

console.log(JSON.stringify(debug, null, 2));
await browser.close();
