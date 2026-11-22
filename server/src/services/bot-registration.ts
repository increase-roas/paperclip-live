/**
 * Registration plan for the gateway bots Paperclip knows about but has no agent
 * row for (`KNOWN_GATEWAY_BOTS`).
 *
 * The plan is read-only and complete before anything is written: it says which
 * catalog bots would become agents, which are skipped because an agent with the
 * same slug already exists, and the exact row each create would insert. `apply`
 * runs the same plan inside one transaction, so a second run creates nothing.
 *
 * The created agents are `paused` and use `hermes_gateway`: registering a bot
 * gives it a page, a status and a place for routines. It does not start work.
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { insertBotAgents } from "../modules/agent-lifecycle/index.js";
import {
  botSlug,
  knownGatewayBotsForCompany,
  type BotRegistrationEntry,
  type BotRegistrationPlan,
  type KnownGatewayBot,
} from "@paperclipai/shared";

type PlannedBotAgent = NonNullable<BotRegistrationEntry["agent"]>;

function plannedAgent(known: KnownGatewayBot): PlannedBotAgent {
  return {
    name: known.name,
    role: "general",
    title: known.name,
    adapterType: "hermes_gateway",
    status: "paused",
    metadata: {
      agentKind: "bot",
      bot: { purpose: known.purpose, transport: "hermes_gateway" },
    },
  };
}

/**
 * Pure planner: the caller supplies the company's catalog bots and the slugs
 * that already have an agent row.
 */
export function planBotRegistration(input: {
  companyId: string;
  companyName: string | null;
  known: readonly KnownGatewayBot[];
  existingSlugs: Iterable<string>;
}): BotRegistrationPlan {
  const existing = new Set([...input.existingSlugs].map((slug) => slug.toLowerCase()));
  const entries: BotRegistrationEntry[] = input.known.map((known) => {
    if (existing.has(known.slug.toLowerCase())) {
      return {
        slug: known.slug,
        name: known.name,
        action: "skip",
        reason: `An agent named like ${known.slug} already exists in this company.`,
        agent: null,
      };
    }
    return {
      slug: known.slug,
      name: known.name,
      action: "create",
      reason: known.purpose
        ? "No agent row yet; this bot already has a known purpose."
        : "No agent row yet, and no recorded purpose. The new page asks for one.",
      agent: plannedAgent(known),
    };
  });
  return {
    companyId: input.companyId,
    companyName: input.companyName,
    entries,
    creates: entries.filter((entry) => entry.action === "create").length,
    skips: entries.filter((entry) => entry.action === "skip").length,
  };
}

export function botRegistrationService(db: Db) {
  async function loadCompany(companyId: string) {
    const [company] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    return company ?? null;
  }

  async function existingSlugs(companyId: string): Promise<string[]> {
    const rows = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    return rows.map((row) => botSlug(row.name));
  }

  async function plan(companyId: string): Promise<BotRegistrationPlan | null> {
    const company = await loadCompany(companyId);
    if (!company) return null;
    return planBotRegistration({
      companyId,
      companyName: company.name,
      known: knownGatewayBotsForCompany(company.name),
      existingSlugs: await existingSlugs(companyId),
    });
  }

  /**
   * Apply the plan. Idempotent: the slug check happens inside the transaction
   * that inserts, so a second call, or a concurrent one, creates nothing twice.
   */
  async function apply(companyId: string): Promise<BotRegistrationPlan | null> {
    const company = await loadCompany(companyId);
    if (!company) return null;
    const known = knownGatewayBotsForCompany(company.name);
    const applied = await db.transaction(async (tx) => {
      // One lock per company makes the read-then-insert atomic even when two
      // registrations start together.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${companyId}))`);
      const rows = await tx.select({ name: agents.name }).from(agents).where(eq(agents.companyId, companyId));
      const entries = planBotRegistration({
        companyId,
        companyName: company.name,
        known,
        existingSlugs: rows.map((row) => botSlug(row.name)),
      }).entries;
      const inserts = entries.flatMap((entry) => (entry.action === "create" && entry.agent ? [{ companyId, ...entry.agent }] : []));
      await insertBotAgents(tx, inserts);
      return entries;
    });
    return {
      companyId,
      companyName: company.name,
      entries: applied,
      creates: applied.filter((entry) => entry.action === "create").length,
      skips: applied.filter((entry) => entry.action === "skip").length,
    };
  }

  return { plan, apply };
}

export type BotRegistration = ReturnType<typeof botRegistrationService>;
