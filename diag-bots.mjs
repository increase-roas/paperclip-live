import { chromium } from "@playwright/test";

const base = "http://127.0.0.1:3200";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const company = await (await page.request.post(`${base}/api/companies`, { data: { name: `Increase Roas` } })).json();
await page.goto(`${base}/${company.issuePrefix}/bots`);
await page.waitForTimeout(2000);
const hrefs = await page.locator('a[href*="/bots/"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
const unique = [...new Set(hrefs)];
console.log("bots:", unique.length, unique.join(","));
for (const [i, href] of unique.entries()) {
  await page.goto(`${base}${href}`);
  await page.waitForTimeout(1200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const headings = await page.locator("h2").allInnerTexts();
  await page.screenshot({ path: `/tmp/lane-d-audit/bot-${i}-390.png`, fullPage: true });
  console.log(i, href, "overflow", overflow, "h2", JSON.stringify(headings));
}
await browser.close();
