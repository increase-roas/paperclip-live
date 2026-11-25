import type { DashboardTableRow } from "@paperclipai/shared";

/**
 * One person on the Increase ROAS roster, as the Team & capital table
 * (`agency_team`) stores them. `judgedOn` is the single number the person is
 * judged on; `hours` is their scheduled hours, not billable hours.
 */
export interface TeamRosterMember {
  id: string;
  name: string;
  role: string;
  rateType: string;
  rate: string;
  hours: number | null;
  duties: string;
  judgedOn: string;
  status: string;
}

/** `null` means no read-only route exists; it never means an empty roster. */
export type TeamRosterRead = {
  observedAt: string;
  members: TeamRosterMember[];
} | null;

export interface TeamRosterAdapter {
  readonly sourceId: "team_capital";
  read(companyId: string): Promise<TeamRosterRead>;
}

interface RawTeamMember {
  id?: string;
  name?: string;
  role?: string;
  rateType?: string;
  rateAmount?: number | null;
  hoursPerMonth?: number | null;
  responsibilities?: string;
  performanceCriteria?: string;
  status?: string;
}

function formatRate(rateType: string, amount: number | null | undefined): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
  if (rateType === "commission") return `${amount}%`;
  return `$${amount.toLocaleString("en-US")}`;
}

/**
 * Reads live human team roster from dashboard.increaseai.tech (`/api/pilot/admin/team`)
 * using server-side `SALES_DASHBOARD_ADMIN_KEY`. Fails closed to `null` when unset or unreachable
 * so offline unit tests stay deterministic and missing data never renders as fake zeros.
 */
export function teamCapitalAdapter(fetchImpl: typeof fetch = fetch): TeamRosterAdapter {
  return {
    sourceId: "team_capital",
    async read(_companyId: string): Promise<TeamRosterRead> {
      const adminKey = (process.env.SALES_DASHBOARD_ADMIN_KEY ?? "").trim();
      if (!adminKey) return null;
      const base = (process.env.SALES_DASHBOARD_BASE_URL ?? "https://dashboard.increaseai.tech").trim().replace(/\/+$/, "");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetchImpl(`${base}/api/pilot/admin/team`, {
          headers: {
            Authorization: `Bearer ${adminKey}`,
            Accept: "application/json",
            "User-Agent": "paperclip-server/1.0",
          },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { ok?: boolean; generatedAt?: string; members?: RawTeamMember[] };
        if (!body?.ok || !Array.isArray(body.members)) return null;
        const members: TeamRosterMember[] = body.members.map((m, idx) => ({
          id: String(m.id ?? `member-${idx + 1}`),
          name: String(m.name ?? "Unnamed"),
          role: String(m.role ?? "—"),
          rateType: String(m.rateType ?? "—"),
          rate: formatRate(String(m.rateType ?? ""), m.rateAmount),
          hours: typeof m.hoursPerMonth === "number" ? m.hoursPerMonth : null,
          duties: String(m.responsibilities ?? "—"),
          judgedOn: String(m.performanceCriteria ?? "NOT SET") || "NOT SET",
          status: String(m.status ?? "active"),
        }));
        return {
          observedAt: typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString(),
          members,
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Maps roster members to table rows keyed by member id. */
export function teamRosterRows(members: TeamRosterMember[]): DashboardTableRow[] {
  return members.map((member) => ({
    id: member.id,
    cells: {
      name: member.name,
      role: member.role,
      rateType: member.rateType,
      rate: member.rate,
      hours: member.hours,
      duties: member.duties,
      judgedOn: member.judgedOn,
      status: member.status,
    },
  }));
}
