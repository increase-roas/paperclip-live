import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { botRegistrationService, planBotRegistration } from "../services/bot-registration.js";
import { KNOWN_GATEWAY_BOTS } from "@paperclipai/shared";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

async function createCompanyNamed(db: Db, name: string) {
  return db
    .insert(companies)
    .values({ name, issuePrefix: `R${randomUUID().slice(0, 6).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

describe("planBotRegistration", () => {
  const known = KNOWN_GATEWAY_BOTS.filter((bot) => bot.company === "Increase Roas");

  it("plans one paused Hermes agent per catalog bot and keeps the purpose", () => {
    const plan = planBotRegistration({
      companyId: "company-1",
      companyName: "Increase Roas",
      known,
      existingSlugs: [],
    });

    expect(plan.creates).toBe(known.length);
    expect(plan.skips).toBe(0);
    const funnel = plan.entries.find((entry) => entry.slug === "funnel-builder");
    expect(funnel).toMatchObject({
      action: "create",
      agent: {
        name: "Funnel Builder",
        adapterType: "hermes_gateway",
        status: "paused",
        metadata: {
          agentKind: "bot",
          bot: {
            purpose: "Builds and maintains funnels and landing pages through the gateway website-builder policy.",
            transport: "hermes_gateway",
          },
        },
      },
    });
    // A bot without a known purpose still gets a row; its page asks for one.
    const kiwi = plan.entries.find((entry) => entry.slug === "kiwi");
    expect(kiwi?.agent?.metadata.bot.purpose).toBeNull();
  });

  it("skips a bot whose slug already has an agent", () => {
    const plan = planBotRegistration({
      companyId: "company-1",
      companyName: "Increase Roas",
      known,
      existingSlugs: ["Funnel-Builder", "kiwi"],
    });
    expect(plan.skips).toBe(2);
    expect(plan.entries.filter((entry) => entry.action === "skip").map((entry) => entry.slug)).toEqual([
      "funnel-builder",
      "kiwi",
    ]);
    expect(plan.entries.find((entry) => entry.slug === "kiwi")?.agent).toBeNull();
  });

  it("returns an empty plan for a company without catalog bots", () => {
    const plan = planBotRegistration({
      companyId: "company-2",
      companyName: "Agent Optimization",
      known: [],
      existingSlugs: [],
    });
    expect(plan).toMatchObject({ entries: [], creates: 0, skips: 0 });
  });
});

describePostgres("bot registration service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bot-registration-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  it("plans without writing anything", async () => {
    const company = await createCompanyNamed(db, "Increase Roas");
    const service = botRegistrationService(db);

    const plan = await service.plan(company.id);
    expect(plan?.creates).toBe(6);
    expect(await db.select().from(agents)).toEqual([]);
  });

  it("applies the plan once and never twice", async () => {
    const company = await createCompanyNamed(db, "Increase Roas");
    const service = botRegistrationService(db);

    const first = await service.apply(company.id);
    expect(first?.creates).toBe(6);
    const rows = await db.select().from(agents);
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.name).sort()).toEqual(
      ["Drive Organizer", "Funnel Builder", "Hermes Specialist", "Kiwi", "Workflow Builder", "dr eggbot"],
    );
    for (const row of rows) {
      expect(row.status).toBe("paused");
      expect(row.adapterType).toBe("hermes_gateway");
      expect(row.metadata).toMatchObject({ agentKind: "bot" });
    }

    const second = await service.apply(company.id);
    expect(second).toMatchObject({ creates: 0, skips: 6 });
    expect(await db.select().from(agents)).toHaveLength(6);
  });

  it("leaves an existing agent alone and only fills the gaps", async () => {
    const company = await createCompanyNamed(db, "Increase Roas");
    await db.insert(agents).values({
      companyId: company.id,
      name: "Funnel Builder",
      status: "idle",
      metadata: { agentKind: "bot", bot: { purpose: "Hand-tuned purpose." } },
    });
    const service = botRegistrationService(db);

    const plan = await service.plan(company.id);
    expect(plan?.skips).toBe(1);
    expect(plan?.entries.find((entry) => entry.slug === "funnel-builder")?.action).toBe("skip");

    const applied = await service.apply(company.id);
    expect(applied?.creates).toBe(5);
    const [funnel] = await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.name, "Funnel Builder")));
    expect(funnel?.metadata).toMatchObject({ bot: { purpose: "Hand-tuned purpose." } });
  });

  it("returns null for an unknown company", async () => {
    const service = botRegistrationService(db);
    await expect(service.plan("00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
    await expect(service.apply("00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
  });

  it("shows the registered bots on their own pages after applying", async () => {
    const company = await createCompanyNamed(db, "Increase Roas");
    const service = botRegistrationService(db);
    await service.apply(company.id);

    const { botsService } = await import("../services/bots.js");
    const bots = botsService(db);
    const list = await bots.list(company.id);
    const funnel = list.find((bot) => bot.slug === "funnel-builder");
    expect(funnel).toMatchObject({ registered: true, taggedAsBot: true, kind: "agent" });
    expect(funnel?.purpose).toContain("funnels and landing pages");

    const detail = await bots.get(company.id, "funnel-builder");
    expect(detail).toMatchObject({ name: "Funnel Builder", routines: [], recentActivity: [] });
  });
});
