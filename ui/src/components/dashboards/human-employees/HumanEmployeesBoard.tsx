import { useEffect, useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import {
  dashboardBoardsApi,
  type DashboardBoardWithMeta,
  type HumanEmployeesBoardMeta,
  type TeamMemberEditable,
} from "@/api/dashboardBoards";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { DashboardPeriod } from "../period";
import { BoardFrame } from "../lane2-shared/BoardFrame";
import { BoardSections } from "../lane2-shared/BoardSections";
import { DashboardBoardShell } from "../lane2-shared/DashboardBoardShell";

const SUBTITLE =
  "One self-chosen number per seat, and how many metrics each seat can name for their own job. One row per person: role, rate, duties and status.";

const usdWholeFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

interface LaborRunwaySummary {
  monthlyLaborUsd: number | null;
  monthlyOverheadUsd: number | null;
  monthlyBurnUsd: number | null;
  runwayMonths: number | null;
  cashOnHandUsd: number | null;
}

function pickNumber(...candidates: Array<number | null | undefined>): number | null {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function centsToUsd(cents: number | null | undefined): number | null {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  return cents / 100;
}

export function extractLaborRunway(meta: HumanEmployeesBoardMeta | undefined): LaborRunwaySummary | null {
  if (!meta) return null;
  const cap = meta.capital;
  const settings = meta.settings;
  const monthlyLaborUsd = pickNumber(
    meta.monthlyLaborUsd,
    meta.monthlyLabor,
    centsToUsd(meta.monthlyLaborCents),
    cap?.monthlyLaborUsd,
    cap?.monthlyLabor,
  );
  const monthlyOverheadUsd = pickNumber(
    meta.monthlyOverheadUsd,
    meta.monthlyOverhead,
    centsToUsd(meta.monthlyOverheadCents),
    cap?.monthlyOverheadUsd,
    cap?.monthlyOverhead,
    settings?.monthlyOverheadUsd,
    settings?.monthlyOverhead,
  );
  const monthlyBurnUsd = pickNumber(
    meta.monthlyBurnUsd,
    meta.monthlyBurn,
    centsToUsd(meta.monthlyBurnCents),
    cap?.monthlyBurnUsd,
    cap?.monthlyBurn,
    monthlyLaborUsd !== null && monthlyOverheadUsd !== null
      ? monthlyLaborUsd + monthlyOverheadUsd
      : null,
  );
  const cashOnHandUsd = pickNumber(
    meta.cashOnHandUsd,
    meta.cashOnHand,
    centsToUsd(meta.cashOnHandCents),
    cap?.cashOnHandUsd,
    cap?.cashOnHand,
    settings?.cashOnHandUsd,
    settings?.cashOnHand,
  );
  const runwayMonths = pickNumber(
    meta.runwayMonths,
    meta.runway,
    cap?.runwayMonths,
    cap?.runway,
    cashOnHandUsd !== null && monthlyBurnUsd !== null && monthlyBurnUsd > 0
      ? Math.round((cashOnHandUsd / monthlyBurnUsd) * 10) / 10
      : null,
  );

  if (
    monthlyLaborUsd === null &&
    monthlyOverheadUsd === null &&
    monthlyBurnUsd === null &&
    runwayMonths === null
  ) {
    return null;
  }

  return {
    monthlyLaborUsd,
    monthlyOverheadUsd,
    monthlyBurnUsd,
    runwayMonths,
    cashOnHandUsd,
  };
}

function parseNumericRate(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[$,%\s,]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractEditableMembers(data: DashboardBoardWithMeta): TeamMemberEditable[] {
  if (Array.isArray(data.meta?.members) && data.meta.members.length > 0) {
    return data.meta.members.map((member) => ({ ...member }));
  }
  const rosterTable = data.tables.find((table) => table.id === "team-roster");
  if (!rosterTable || rosterTable.rows.length === 0) return [];
  return rosterTable.rows.map((row) => ({
    id: row.id,
    name: String(row.cells.name ?? ""),
    role: String(row.cells.role ?? ""),
    rateType: String(row.cells.rateType ?? "monthly"),
    rateAmount: parseNumericRate(row.cells.rate),
    hoursPerMonth:
      typeof row.cells.hours === "number"
        ? row.cells.hours
        : parseNumericRate(row.cells.hours),
    responsibilities: row.cells.duties ? String(row.cells.duties) : undefined,
    performanceCriteria: String(row.cells.judgedOn ?? ""),
    status: String(row.cells.status ?? "active"),
  }));
}

function formatUsdOrDash(value: number | null): string {
  if (value === null) return "—";
  return usdWholeFormat.format(value);
}

function formatRunwayOrDash(months: number | null): string {
  if (months === null) return "—";
  return `${months.toFixed(1)} mo`;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

interface ManageTeamCapitalSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: DashboardBoardWithMeta;
  summary: LaborRunwaySummary | null;
  onSaved?: () => Promise<unknown>;
}

function ManageTeamCapitalSheet({
  open,
  onOpenChange,
  data,
  summary,
  onSaved,
}: ManageTeamCapitalSheetProps) {
  const initialMembers = useMemo(() => extractEditableMembers(data), [data]);
  const [members, setMembers] = useState<TeamMemberEditable[]>(initialMembers);
  const [cashOnHand, setCashOnHand] = useState<string>(
    summary?.cashOnHandUsd !== null && summary?.cashOnHandUsd !== undefined
      ? String(summary.cashOnHandUsd)
      : "",
  );
  const [monthlyOverhead, setMonthlyOverhead] = useState<string>(
    summary?.monthlyOverheadUsd !== null && summary?.monthlyOverheadUsd !== undefined
      ? String(summary.monthlyOverheadUsd)
      : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMembers(initialMembers);
    setCashOnHand(
      summary?.cashOnHandUsd !== null && summary?.cashOnHandUsd !== undefined
        ? String(summary.cashOnHandUsd)
        : "",
    );
    setMonthlyOverhead(
      summary?.monthlyOverheadUsd !== null && summary?.monthlyOverheadUsd !== undefined
        ? String(summary.monthlyOverheadUsd)
        : "",
    );
    setError(null);
  }, [open, initialMembers, summary]);

  const updateMemberField = <K extends keyof TeamMemberEditable>(
    id: string,
    field: K,
    value: TeamMemberEditable[K],
  ) => {
    setMembers((prev) =>
      prev.map((member) => (member.id === id ? { ...member, [field]: value } : member)),
    );
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const cashVal = parseOptionalNumber(cashOnHand);
      const overheadVal = parseOptionalNumber(monthlyOverhead);

      if (members.length > 0) {
        await dashboardBoardsApi.updateTeam({ members });
      }
      if (cashVal !== null || overheadVal !== null) {
        await dashboardBoardsApi.updateTeamSettings({
          ...(cashVal !== null ? { cashOnHand: cashVal } : {}),
          ...(overheadVal !== null ? { monthlyOverhead: overheadVal } : {}),
        });
      }
      await onSaved?.();
      onOpenChange(false);
    } catch (err) {
      setError(describeError(err).body);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        data-testid="manage-team-capital-sheet"
      >
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>Manage team &amp; capital</SheetTitle>
          <SheetDescription>
            Update monthly overhead, cash on hand, and each seat&apos;s rate, hours, and judged-on metric.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
            {error ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </div>
            ) : null}

            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Agency capital settings
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="capital-cash-on-hand">Cash on hand (USD)</Label>
                  <Input
                    id="capital-cash-on-hand"
                    type="number"
                    min="0"
                    step="any"
                    value={cashOnHand}
                    onChange={(e) => setCashOnHand(e.target.value)}
                    placeholder="e.g. 120000"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="capital-monthly-overhead">Monthly overhead (USD)</Label>
                  <Input
                    id="capital-monthly-overhead"
                    type="number"
                    min="0"
                    step="any"
                    value={monthlyOverhead}
                    onChange={(e) => setMonthlyOverhead(e.target.value)}
                    placeholder="e.g. 4500"
                  />
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Team roster ({members.length})
              </h3>
              {members.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
                  No team roster rows loaded yet. Connect the Team &amp; capital source to edit individual seats here.
                </p>
              ) : (
                <div className="space-y-3">
                  {members.map((member) => (
                    <Card key={member.id} elevation="low" className="gap-3 p-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium text-foreground">{member.name}</p>
                          <p className="text-xs text-muted-foreground">{member.role}</p>
                        </div>
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          {member.status}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                        <div className="space-y-1">
                          <Label htmlFor={`member-rate-type-${member.id}`} className="text-xs">
                            Rate type
                          </Label>
                          <Input
                            id={`member-rate-type-${member.id}`}
                            value={member.rateType}
                            onChange={(e) => updateMemberField(member.id, "rateType", e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`member-rate-${member.id}`} className="text-xs">
                            Rate
                          </Label>
                          <Input
                            id={`member-rate-${member.id}`}
                            type="number"
                            min="0"
                            step="any"
                            value={member.rateAmount ?? ""}
                            onChange={(e) =>
                              updateMemberField(
                                member.id,
                                "rateAmount",
                                parseOptionalNumber(e.target.value),
                              )
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`member-hours-${member.id}`} className="text-xs">
                            Hours / mo
                          </Label>
                          <Input
                            id={`member-hours-${member.id}`}
                            type="number"
                            min="0"
                            step="any"
                            value={member.hoursPerMonth ?? ""}
                            onChange={(e) =>
                              updateMemberField(
                                member.id,
                                "hoursPerMonth",
                                parseOptionalNumber(e.target.value),
                              )
                            }
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor={`member-judged-${member.id}`} className="text-xs">
                          Judged-on metric
                        </Label>
                        <Input
                          id={`member-judged-${member.id}`}
                          value={member.performanceCriteria}
                          onChange={(e) =>
                            updateMemberField(member.id, "performanceCriteria", e.target.value)
                          }
                          placeholder="One clear number this seat owns"
                        />
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="flex items-center justify-between border-t border-border px-5 py-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Pure view. Renders only the payload it is given. */
export function HumanEmployeesBoardView({
  data,
  onRefresh,
}: {
  data: DashboardBoardWithMeta;
  onRefresh?: () => Promise<unknown>;
}) {
  const [manageOpen, setManageOpen] = useState(false);
  const laborRunway = useMemo(() => extractLaborRunway(data.meta), [data.meta]);

  return (
    <BoardFrame
      title="Human employees"
      subtitle={SUBTITLE}
      data={data}
      actions={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setManageOpen(true)}
          data-testid="manage-team-capital-button"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden />
          Manage team &amp; capital
        </Button>
      }
    >
      {laborRunway ? (
        <section
          aria-label="Labor and runway summary"
          data-testid="human-employees-labor-runway"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        >
          <Card elevation="low" className="gap-2 px-4 py-4 sm:px-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Monthly labor
            </p>
            <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground sm:text-3xl">
              {formatUsdOrDash(laborRunway.monthlyLaborUsd)}
            </p>
            <p className="text-xs text-muted-foreground">Active payroll &amp; contractors</p>
          </Card>
          <Card elevation="low" className="gap-2 px-4 py-4 sm:px-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Monthly overhead
            </p>
            <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground sm:text-3xl">
              {formatUsdOrDash(laborRunway.monthlyOverheadUsd)}
            </p>
            <p className="text-xs text-muted-foreground">Fixed software &amp; operating tools</p>
          </Card>
          <Card elevation="low" className="gap-2 px-4 py-4 sm:px-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Monthly burn
            </p>
            <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground sm:text-3xl">
              {formatUsdOrDash(laborRunway.monthlyBurnUsd)}
            </p>
            <p className="text-xs text-muted-foreground">Monthly labor + overhead</p>
          </Card>
          <Card elevation="low" className="gap-2 px-4 py-4 sm:px-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Runway
            </p>
            <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground sm:text-3xl">
              {formatRunwayOrDash(laborRunway.runwayMonths)}
            </p>
            <p className="text-xs text-muted-foreground">
              {laborRunway.cashOnHandUsd !== null
                ? `Cash on hand ${formatUsdOrDash(laborRunway.cashOnHandUsd)}`
                : "Cash on hand ÷ monthly burn"}
            </p>
          </Card>
        </section>
      ) : null}

      <BoardSections data={data} />

      <ManageTeamCapitalSheet
        open={manageOpen}
        onOpenChange={setManageOpen}
        data={data}
        summary={laborRunway}
        onSaved={onRefresh}
      />
    </BoardFrame>
  );
}

export function HumanEmployeesBoard({
  companyId,
  period,
}: { companyId?: string; period?: DashboardPeriod } = {}) {
  return (
    <DashboardBoardShell
      board="human-employees"
      title="Human employees"
      companyId={companyId}
      period={period}
    >
      {(data, refetch) => <HumanEmployeesBoardView data={data} onRefresh={refetch} />}
    </DashboardBoardShell>
  );
}
