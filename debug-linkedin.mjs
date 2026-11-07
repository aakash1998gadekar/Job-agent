import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1366, height: 768 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
});
const page = await context.newPage();

console.log('Navigating to LinkedIn login...');
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await new Promise(r => setTimeout(r, 3000));

console.log('Current URL:', page.url());
const title = await page.title();
console.log('Page title:', title);

// Check what form elements exist
const inputs = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('input')).map(i => ({
    id: i.id, name: i.name, type: i.type, placeholder: i.placeholder
  }));
});
console.log('Input fields:', JSON.stringify(inputs, null, 2));

await browser.close();
