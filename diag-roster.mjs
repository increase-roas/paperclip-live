import { chromium } from "@playwright/test";

const base = "http://127.0.0.1:3200";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

const company = await page.request.post(`${base}/api/companies`, { data: { name: `Roster Diag ${Date.now()}` } });
const c = await company.json();
for (const spec of [{ name: "Ada Controller", role: "ceo" }, { name: "Robotics Integration And Fleet Operations Specialist With A Long Name", role: "engineer" }]) {
  await page.request.post(`${base}/api/companies/${c.id}/agents`, {
    data: { ...spec, adapterType: "process", adapterConfig: { command: "/usr/bin/true" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } },
  });
}

await page.goto(`${base}/${c.issuePrefix}/agents/all`);
await page.waitForTimeout(2500);
const report = await page.evaluate(() => {
  const doc = document.documentElement;
  const out = { viewport: doc.clientWidth, scrollWidth: doc.scrollWidth, offenders: [], ancestors: [] };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().slice(0, 160),
      width: Math.round(r.width),
      right: Math.round(r.right),
      left: Math.round(r.left),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
    };
  };
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.right > doc.clientWidth + 1 && r.width > 0) out.offenders.push(describe(el));
  }
  out.offenders = out.offenders.slice(0, 25);
  let el = document.querySelector("table[aria-label='Agent roster']");
  while (el && el !== document.body) { out.ancestors.push(describe(el)); el = el.parentElement; }
  return out;
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
