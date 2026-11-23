import { chromium } from "@playwright/test";

const base = "http://127.0.0.1:3200";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

const list = await (await page.request.get(`${base}/api/companies`)).json();
const company = list[0];
const agents = await (await page.request.get(`${base}/api/companies/${company.id}/agents`)).json();
for (const agent of agents) {
  const ref = agent.urlKey ?? agent.id;
  await page.goto(`${base}/${company.issuePrefix}/agents/${ref}/overview`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `/tmp/lane-d-audit/detail-${agent.name.slice(0, 10).replace(/\W/g, "")}-390.png`, fullPage: true });
  const header = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const r = h1?.getBoundingClientRect();
    return { text: h1?.textContent, width: r?.width, height: r?.height, x: r?.x, y: r?.y,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      h1Class: h1?.className, overflow: h1 ? getComputedStyle(h1).overflow : null, whiteSpace: h1 ? getComputedStyle(h1).whiteSpace : null };
  });
  console.log(agent.name, JSON.stringify(header));
}
await browser.close();
