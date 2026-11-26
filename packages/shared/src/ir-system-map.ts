/**
 * Contract between the brain-vps `ir-system-feed` (company-ops
 * `tools/ir-system-feed`), the Paperclip server proxy (`server/src/ir/system-map.ts`)
 * and the native System Map page (`ui/src/ir/pages/SystemMapPage.tsx`).
 */

export type SystemHealthStatus = "green" | "yellow" | "red" | "unknown";

export interface SystemDoctorCheck {
  key: string;
  status: SystemHealthStatus;
  anomalies: string[];
}

export interface SystemService {
  key: string;
  label: string;
  host: string;
  status: "ok" | "down" | "unknown";
  detail: string | null;
  latencyMs: number | null;
}

export interface SystemHost {
  key: string;
  label: string;
  role: string;
  services: string[];
}

export interface SystemRegister {
  name: string;
  path: string;
  entries: number | null;
  updatedAt: string | null;
}

export interface SystemDataSource {
  key: string;
  label: string;
  observedAt: string | null;
  detail: string | null;
}

/** `GET /v1/system-map` on the feed. */
export interface SystemMapFeed {
  feedVersion: string;
  generatedAt: string;
  doctor: {
    observedAt: string | null;
    overallStatus: SystemHealthStatus;
    anomalies: string[];
    checks: SystemDoctorCheck[];
    error: string | null;
  };
  hosts: SystemHost[];
  services: SystemService[];
  registers: SystemRegister[];
  sources: SystemDataSource[];
}

export type ProofCheckStatus = "pass" | "fail" | "unknown";

export interface ProofCheckResult {
  key: string;
  status: ProofCheckStatus;
  detail: string | null;
  observedAt: string | null;
}

/** `GET /v1/proof-checks` on the feed. */
export interface ProofChecksFeed {
  generatedAt: string;
  checks: ProofCheckResult[];
}

export interface SkeletonPageType {
  name: string;
  primitive: string;
  pathPrefixes: string[];
  aliases: string[];
  count: number;
  violationCount: number;
}

/** A governed folder and the frontmatter fields every page in it must carry. */
export interface SkeletonRequiredFolder {
  prefix: string;
  fields: string[];
  pages: number;
  violations: number;
}

export interface SkeletonLinkType {
  name: string;
  inverse: string | null;
}

export interface SkeletonEdge {
  fromType: string;
  toType: string;
  count: number;
}

export interface SkeletonViolationSample {
  page: string;
  detail: string;
}

export interface SkeletonViolationGroup {
  count: number;
  sample: SkeletonViolationSample[];
}

export interface SkeletonDefinition {
  slug: string;
  title: string;
  term: string;
  brands: string[];
  calculation: string;
  certified: boolean;
}

export interface SkeletonBrand {
  slug: string;
  code: string;
  title: string;
  company: string | null;
}

/** A GBrain client page (`companies/` with `kind: customer`). */
export interface SkeletonClient {
  slug: string;
  title: string;
  aliases: string[];
  brands: string[];
  /** `client_status` frontmatter: active / paused / cancelled, or null when not recorded. */
  lifecycle: string | null;
}

/** `GET /v1/gbrain/skeleton` on the feed. */
export interface GbrainSkeletonFeed {
  generatedAt: string;
  pack: { name: string; version: string; identity: string | null; description: string | null };
  requiredFieldsVersion: string | null;
  requiredFolders: SkeletonRequiredFolder[];
  totals: { totalPages: number; typedPages: number; undeclaredPages: number; coverage: number | null };
  pageTypes: SkeletonPageType[];
  linkTypes: SkeletonLinkType[];
  edges: SkeletonEdge[];
  lint: { ok: boolean; errors: Array<{ rule: string; message: string }>; warningCount: number };
  violations: {
    brokenLinks: SkeletonViolationGroup;
    missingRequired: SkeletonViolationGroup;
    undeclaredTypes: SkeletonViolationGroup;
    invalidBrands: SkeletonViolationGroup;
  };
  definitions: SkeletonDefinition[];
  brands: SkeletonBrand[];
  clients: SkeletonClient[];
}

/** Data older than this is shown as stale (red) on the System Map. */
export const SYSTEM_MAP_STALE_AFTER_SECONDS = 15 * 60;

export interface Freshness {
  observedAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  thresholdSeconds: number;
}

export function freshnessOf(observedAt: string | null | undefined, now: Date = new Date()): Freshness {
  const parsed = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return { observedAt: observedAt ?? null, ageSeconds: null, stale: true, thresholdSeconds: SYSTEM_MAP_STALE_AFTER_SECONDS };
  }
  const ageSeconds = Math.max(0, Math.round((now.getTime() - parsed) / 1000));
  return {
    observedAt: observedAt ?? null,
    ageSeconds,
    stale: ageSeconds > SYSTEM_MAP_STALE_AFTER_SECONDS,
    thresholdSeconds: SYSTEM_MAP_STALE_AFTER_SECONDS,
  };
}

/** Paperclip `GET /api/ir/system-map` response. */
export interface SystemMapResponse {
  feed: SystemMapFeed;
  freshness: Freshness;
}

/** Paperclip `GET /api/ir/system-map/gbrain-skeleton` response. */
export interface GbrainSkeletonResponse {
  skeleton: GbrainSkeletonFeed;
  freshness: Freshness;
}

/** Paperclip `GET /api/ir/proof-checks` response. */
export interface ProofChecksResponse {
  checks: ProofCheckResult[];
  freshness: Freshness;
}

/** An issue names its proof check with a label such as `proof:gateway`. */
export const PROOF_LABEL_PREFIX = "proof:";

export function requiredProofCheckFromLabels(labels: ReadonlyArray<{ name: string }>): string | null {
  for (const label of labels) {
    const name = label.name.trim();
    if (name.toLowerCase().startsWith(PROOF_LABEL_PREFIX)) {
      const key = name.slice(PROOF_LABEL_PREFIX.length).trim().toLowerCase();
      if (key) return key;
    }
  }
  return null;
}

/**
 * Closing an issue that names a proof check is allowed only while that check
 * reports `pass` in a fresh snapshot. Missing, failing, unknown or stale = blocked.
 */
export function proofCheckAllowsClosure(
  key: string,
  checks: ReadonlyArray<ProofCheckResult> | null,
  freshness: Pick<Freshness, "stale"> | null,
): { allowed: boolean; status: ProofCheckStatus | "missing" | "stale"; detail: string | null } {
  if (!checks || !freshness) return { allowed: false, status: "missing", detail: "Proof checks are not reachable." };
  const check = checks.find((candidate) => candidate.key === key);
  if (!check) return { allowed: false, status: "missing", detail: `No proof check named "${key}".` };
  if (freshness.stale) return { allowed: false, status: "stale", detail: "Proof check results are stale." };
  return { allowed: check.status === "pass", status: check.status, detail: check.detail };
}
