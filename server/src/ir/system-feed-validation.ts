import { z } from "zod";
import type { GbrainSkeletonFeed, ProofChecksFeed, SystemMapFeed } from "@paperclipai/shared/ir-system-map";

const text = z.string();
const nullableText = text.nullable();
const texts = z.array(text);
const count = z.number().int().nonnegative();
const healthStatus = z.enum(["green", "yellow", "red", "unknown"]);

const systemMapSchema: z.ZodType<SystemMapFeed> = z.object({
  feedVersion: text,
  generatedAt: text,
  doctor: z.object({
    observedAt: nullableText,
    overallStatus: healthStatus,
    anomalies: texts,
    checks: z.array(z.object({ key: text, status: healthStatus, anomalies: texts })),
    error: nullableText,
  }),
  hosts: z.array(z.object({ key: text, label: text, role: text, services: texts })),
  services: z.array(z.object({
    key: text, label: text, host: text, status: z.enum(["ok", "down", "unknown"]),
    detail: nullableText, latencyMs: z.number().nullable(),
  })),
  registers: z.array(z.object({ name: text, path: text, entries: count.nullable(), updatedAt: nullableText })),
  sources: z.array(z.object({ key: text, label: text, observedAt: nullableText, detail: nullableText })),
});

const violationGroup = z.object({
  count,
  sample: z.array(z.object({ page: text, detail: text })),
});

const skeletonSchema: z.ZodType<GbrainSkeletonFeed> = z.object({
  generatedAt: text,
  pack: z.object({ name: text, version: text, identity: nullableText, description: nullableText }),
  requiredFieldsVersion: nullableText,
  requiredFolders: z.array(z.object({ prefix: text, fields: texts, pages: count, violations: count })),
  totals: z.object({ totalPages: count, typedPages: count, undeclaredPages: count, coverage: z.number().nullable() }),
  pageTypes: z.array(z.object({
    name: text, primitive: text, pathPrefixes: texts, aliases: texts, count, violationCount: count,
  })),
  linkTypes: z.array(z.object({ name: text, inverse: nullableText })),
  edges: z.array(z.object({ fromType: text, toType: text, count })),
  lint: z.object({ ok: z.boolean(), errors: z.array(z.object({ rule: text, message: text })), warningCount: count }),
  violations: z.object({
    brokenLinks: violationGroup,
    missingRequired: violationGroup,
    undeclaredTypes: violationGroup,
    invalidBrands: violationGroup,
  }),
  definitions: z.array(z.object({ slug: text, title: text, term: text, brands: texts, calculation: text, certified: z.boolean() })),
  brands: z.array(z.object({ slug: text, code: text, title: text, company: nullableText })),
  clients: z.array(z.object({ slug: text, title: text, aliases: texts, brands: texts })),
});

const proofChecksSchema: z.ZodType<ProofChecksFeed> = z.object({
  generatedAt: text,
  checks: z.array(z.object({ key: text, status: z.enum(["pass", "fail", "unknown"]), detail: nullableText, observedAt: nullableText })),
});

export function isSystemMapFeed(value: unknown): value is SystemMapFeed {
  return systemMapSchema.safeParse(value).success;
}

export function isSkeletonFeed(value: unknown): value is GbrainSkeletonFeed {
  return skeletonSchema.safeParse(value).success;
}

export function isProofChecksFeed(value: unknown): value is ProofChecksFeed {
  return proofChecksSchema.safeParse(value).success;
}
