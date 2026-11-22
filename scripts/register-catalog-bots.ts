/**
 * Show, or apply, the agent rows that the gateway catalog bots need.
 *
 * Dry run is the default and needs no flags:
 *
 *   pnpm tsx scripts/register-catalog-bots.ts
 *   pnpm tsx scripts/register-catalog-bots.ts --company <companyId> --apply
 *
 * A dry run prints every catalog bot with the action it would take and the row
 * it would insert. `--apply` runs the same plan inside one transaction and is
 * idempotent: a second run creates nothing.
 */

import { companies, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { botRegistrationService, type BotRegistrationPlan } from "../server/src/services/bot-registration.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function printPlan(plan: BotRegistrationPlan, mode: "dry-run" | "applied"): void {
  const label = plan.companyName ?? plan.companyId;
  console.log(`\n${label} (${plan.companyId}) — ${mode}`);
  if (plan.entries.length === 0) {
    console.log("  No catalog bots for this company. Nothing to do.");
    return;
  }
  for (const entry of plan.entries) {
    console.log(`  ${entry.action === "create" ? "CREATE" : "skip  "} ${entry.name} (${entry.slug})`);
    console.log(`         ${entry.reason}`);
    if (entry.agent) {
      console.log(
        `         row: name=${entry.agent.name} adapter=${entry.agent.adapterType} status=${entry.agent.status} ` +
          `metadata=${JSON.stringify(entry.agent.metadata)}`,
      );
    }
  }
  console.log(`  ${plan.creates} to create, ${plan.skips} skipped.`);
}

async function main() {
  const apply = hasFlag("--apply");
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const registration = botRegistrationService(db);
  const companyId = parseFlag("--company");
  const rows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  if (rows.length === 0) {
    console.log("No companies found; nothing to register.");
    return;
  }
  if (!apply) {
    console.log("Dry run. Nothing is written. Add --apply to create the listed rows.");
  }

  for (const company of rows) {
    const plan = apply ? await registration.apply(company.id) : await registration.plan(company.id);
    if (!plan) {
      console.log(`\n${company.id} — company not found.`);
      continue;
    }
    printPlan(plan, apply ? "applied" : "dry-run");
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`register-catalog-bots failed: ${message}`);
  process.exitCode = 1;
});
