import type { CSSProperties } from "react";
import { OWN_BRANDS, resolveCalculationPointer } from "@paperclipai/shared/ir-metrics";
import type {
  ProofCheckStatus,
  SkeletonBrand,
  SkeletonDefinition,
  SystemHealthStatus,
  SystemService,
} from "@paperclipai/shared/ir-system-map";

export type Tone = "ok" | "warn" | "bad" | "muted";

/** Paperclip's native status hues (ui/src/index.css), applied through `.status-chip`. */
const TONE_VAR: Record<Tone, string> = {
  ok: "--status-task-done",
  warn: "--status-task-todo",
  bad: "--status-task-blocked",
  muted: "--status-task-backlog",
};

export function toneStyle(tone: Tone): CSSProperties {
  return { "--sc": `var(${TONE_VAR[tone]})` } as CSSProperties;
}

export function healthTone(status: SystemHealthStatus | SystemService["status"] | ProofCheckStatus | string): Tone {
  if (status === "green" || status === "ok" || status === "pass") return "ok";
  if (status === "yellow") return "warn";
  if (status === "red" || status === "down" || status === "fail") return "bad";
  return "muted";
}

export function healthLabel(status: string): string {
  switch (status) {
    case "green":
    case "ok":
    case "pass":
      return "Healthy";
    case "yellow":
      return "Needs attention";
    case "red":
    case "down":
    case "fail":
      return "Down";
    default:
      return "Unknown";
  }
}

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return "unknown age";
  if (ageSeconds < 60) return "just now";
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function ageSecondsSince(iso: string | null, now: Date = new Date()): number | null {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.round((now.getTime() - parsed) / 1000)) : null;
}

const CHECK_LABELS: Record<string, string> = {
  health: "Service health",
  hermes: "Javar profiles",
  paperclip: "Paperclip",
  gateway: "OAuth Gateway",
  git_drift: "Git drift",
  crons: "Scheduled jobs",
  jev_audits: "Jev audits",
  infra: "Servers and backups",
  errors_spend: "Errors and spend",
  db_feeds: "Databases and feeds",
};

export function formatCheckName(key: string): string {
  return CHECK_LABELS[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Diagnostic text as shown in the UI: one agent name everywhere (Javar). */
export function displayDiagnostic(text: string): string {
  return text.replace(/hermes/gi, "javar");
}

export type DefinitionState =
  | { kind: "linked"; formula: string; certified: boolean }
  | { kind: "not_defined" }
  | { kind: "broken"; pointer: string };

/** How a GBrain definition maps onto the canonical metric library. */
export function definitionState(definition: SkeletonDefinition): DefinitionState {
  const resolved = resolveCalculationPointer(definition.calculation);
  if (resolved.kind === "missing") return { kind: "broken", pointer: resolved.pointer };
  if (resolved.kind === "none") return { kind: "not_defined" };
  return { kind: "linked", formula: resolved.definition.formula, certified: definition.certified };
}

export interface BrandCoverageRow {
  code: string;
  name: string;
  page: SkeletonBrand | null;
}

/** The six locked own brands, each matched to its live GBrain `brands/` page (or null). */
export function brandCoverage(brands: readonly SkeletonBrand[]): BrandCoverageRow[] {
  return OWN_BRANDS.map((brand) => ({
    code: brand.code,
    name: brand.name,
    page: brands.find((page) => page.code === brand.code) ?? null,
  }));
}

/** Brand pages whose code is not one of the six own brands. */
export function unexpectedBrandPages(brands: readonly SkeletonBrand[]): SkeletonBrand[] {
  const codes = new Set<string>(OWN_BRANDS.map((brand) => brand.code));
  return brands.filter((page) => !codes.has(page.code));
}
