/**
 * Report what each bot page cannot show, from a running Paperclip instance.
 *
 * Read-only. The Bots API is company-scoped, so pass a company id and a board
 * credential:
 *
 *   pnpm bots:coverage --company <companyId> --header-file ~/.config/paperclip/auth.hdr
 *   pnpm bots:coverage --company <companyId> --base-url http://localhost:3100
 *   pnpm bots:coverage --company <companyId> --json --fail-on-gaps
 *   pnpm bots:coverage --company <companyId> --proposals doc/plans/bot-writes.json
 *
 * `--fail-on-gaps` exits 1 when any page is missing a field, which makes the
 * check usable as a regression gate after a seed or a migration. Nothing is
 * written; secrets are never read beyond the credential header the operator
 * supplies.
 */

import { readFileSync } from "node:fs";
import {
  findBotCoverageGaps,
  renderBotCoverageReport,
  toCoverageBot,
  type BotCoverageBot,
  type BotCoverageProposals,
} from "../server/src/services/bots-coverage.js";

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function authHeaders(headerFile: string | null): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (headerFile) {
    for (const line of readFileSync(headerFile, "utf8").split("\n")) {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (name && value) headers[name.toLowerCase()] = value;
    }
  }
  return headers;
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function main() {
  const companyId = flag("--company");
  const baseUrl = (flag("--base-url") ?? "http://localhost:3100").replace(/\/+$/, "");
  const headerFile = flag("--header-file");
  if (!companyId) {
    console.error("Pass --company <companyId>. Add --base-url and --header-file for a remote instance.");
    process.exitCode = 2;
    return;
  }
  const headers = authHeaders(headerFile);
  const roster = await getJson(`${baseUrl}/api/companies/${companyId}/bots`, headers);
  const bots: BotCoverageBot[] = [];
  for (const summary of roster.bots ?? []) {
    const detail = await getJson(`${baseUrl}/api/companies/${companyId}/bots/${encodeURIComponent(summary.slug ?? summary.id)}`, headers);
    bots.push(toCoverageBot(summary, detail));
  }
  const proposalsPath = flag("--proposals");
  const proposals: BotCoverageProposals = proposalsPath
    ? JSON.parse(readFileSync(proposalsPath, "utf8"))
    : {};
  const findings = findBotCoverageGaps(bots, proposals);
  if (has("--json")) console.log(JSON.stringify({ companyId, bots: bots.length, findings }, null, 2));
  else console.log(`${renderBotCoverageReport(findings, `Bot page coverage (${bots.length} bots)`)}\n`);
  // A drafted write is not a gap: --fail-on-gaps gates on data nobody has a
  // plan for, which is what a seed or migration regression looks like.
  if (has("--fail-on-gaps") && findings.some((finding) => finding.gaps.length > 0)) process.exitCode = 1;
}

await main();
