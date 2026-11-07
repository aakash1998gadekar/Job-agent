#!/usr/bin/env node
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  viewport: { width: 1366, height: 768 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
});
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

const page = await ctx.newPage();
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await new Promise(r => setTimeout(r, 5000));

const url = page.url();
const title = await page.title();

// Find all input elements and their attributes
const inputs = await page.evaluate(() => {
  const els = document.querySelectorAll('input');
  return Array.from(els).map(el => ({
    id: el.id,
    name: el.name,
    type: el.type,
    placeholder: el.placeholder,
    autocomplete: el.autocomplete,
    className: el.className.substring(0, 100),
    ariaLabel: el.getAttribute('aria-label'),
  }));
});

console.log('URL:', url);
console.log('Title:', title);
console.log('Inputs found:', JSON.stringify(inputs, null, 2));

await browser.close();
