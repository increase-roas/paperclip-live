import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentReadinessFinding,
  AgentReadinessSubjectSummary,
  AgentReadinessSummary,
} from "@paperclipai/shared";
import { companies } from "./companies.js";

export const agentReadinessReports = pgTable(
  "agent_readiness_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    status: text("status").$type<"running" | "complete" | "failed">().notNull().default("running"),
    includeLive: boolean("include_live").notNull().default(false),
    summary: jsonb("summary").$type<AgentReadinessSummary | Record<string, never>>().notNull().default({}),
    findings: jsonb("findings").$type<AgentReadinessFinding[]>().notNull().default([]),
    requestedByUserId: text("requested_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    index("agent_readiness_reports_company_started_idx").on(table.companyId, table.startedAt),
    index("agent_readiness_reports_company_status_idx").on(table.companyId, table.status),
    // One inline report per company. A concurrent request gets a 409 instead of
    // running a second live probe set against the same agents.
    uniqueIndex("agent_readiness_reports_running_uq")
      .on(table.companyId)
      .where(sql`${table.status} = 'running'`),
  ],
);

export type AgentReadinessSubjectSnapshot = AgentReadinessSubjectSummary;

export const agentReadinessAttestations = pgTable(
  "agent_readiness_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<"agent" | "bot" | "company">().notNull(),
    subjectId: text("subject_id").notNull(),
    checkId: text("check_id").notNull(),
    note: text("note"),
    attestedByUserId: text("attested_by_user_id").notNull(),
    attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_readiness_attestations_subject_check_uq").on(
      table.companyId,
      table.subjectType,
      table.subjectId,
      table.checkId,
    ),
    index("agent_readiness_attestations_company_idx").on(table.companyId, table.attestedAt),
  ],
);
