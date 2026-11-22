/**
 * Print the bot rebuild / re-registration report for one company. Read-only.
 *
 *   pnpm tsx scripts/agent-rebuild-report.ts --company <companyId>
 *   pnpm tsx scripts/agent-rebuild-report.ts --company <companyId> --json
 */

import { agents, companies, createDb } from "../packages/db/src/index.js";
import { knownGatewayBotsForCompany } from "@paperclipai/shared";
import { loadConfig } from "../server/src/config.js";
import { buildAgentRebuildReport, renderAgentRebuildReport } from "../server/src/services/agent-rebuild-plan.js";
import { eq } from "drizzle-orm";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const companyId = parseFlag("--company");
  if (!companyId) throw new Error("--company <companyId> is required");
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const [company] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) throw new Error(`company not found: ${companyId}`);

  const rows = await db
    .select({ id: agents.id, name: agents.name, status: agents.status, adapterType: agents.adapterType, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const report = buildAgentRebuildReport({
    agents: rows,
    catalogBots: knownGatewayBotsForCompany(company.name),
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ companyId: company.id, companyName: company.name, ...report }, null, 2));
    return;
  }
  process.stdout.write(renderAgentRebuildReport(report, `Bot rebuild report — ${company.name}`));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agent-rebuild-report failed: ${message}`);
  process.exitCode = 1;
});
