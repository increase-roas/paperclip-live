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

/**
 * The Team & capital API (dashboard.increaseai.tech, `/api/pilot/admin/team`)
 * is admin-authenticated. Paperclip has no read-only credential for it, and
 * this task must not create one, so the adapter reports "no read" instead of
 * guessing. When a read-only service credential exists, only this function
 * changes: the board and its table columns stay the same.
 */
export function teamCapitalAdapter(): TeamRosterAdapter {
  return {
    sourceId: "team_capital",
    async read(_companyId: string): Promise<TeamRosterRead> {
      return null;
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
