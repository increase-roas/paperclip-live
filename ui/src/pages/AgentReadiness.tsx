import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  CircleSlash2,
  RefreshCw,
  ShieldCheck,
  Users,
  Wrench,
  X,
} from "lucide-react";
import {
  AGENT_READINESS_CHECKS,
  agentReadinessLevelName,
  type AgentReadinessCheckStatus,
  type AgentReadinessFinding,
  type AgentReadinessLevelResult,
  type AgentReadinessSubjectStatus,
  type AgentReadinessSubjectSummary,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { SidePanelFrame } from "@/components/side-panel/SidePanelFrame";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { agentReadinessApi } from "@/api/agentReadiness";

const MUST_PASS_LEVELS = new Set<number>(
  AGENT_READINESS_CHECKS.filter((check) => check.severity === "must_pass").map((check) => check.level),
);

const STATUS_LABEL: Record<AgentReadinessSubjectStatus, string> = {
  ready: "Ready",
  attention: "Needs attention",
  blocked: "Blocked",
  unverified: "Unverified",
};

const STATUS_CLASS: Record<AgentReadinessSubjectStatus, string> = {
  ready: "border-transparent bg-primary text-primary-foreground",
  attention: "border-transparent bg-secondary text-secondary-foreground",
  blocked: "border-transparent bg-destructive text-white",
  unverified: "border-border bg-transparent text-muted-foreground",
};

const CHECK_STATUS_LABEL: Record<AgentReadinessCheckStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  not_checked: "Not checked",
  skipped: "Not applicable",
};

const CHECK_STATUS_CLASS: Record<AgentReadinessCheckStatus, string> = {
  pass: "border-transparent bg-primary text-primary-foreground",
  fail: "border-transparent bg-destructive text-white",
  not_checked: "border-border bg-transparent text-muted-foreground",
  skipped: "border-border bg-transparent text-muted-foreground",
};

function StatusBadge({ status }: { status: AgentReadinessSubjectStatus }) {
  return <Badge className={STATUS_CLASS[status]}>{STATUS_LABEL[status]}</Badge>;
}

function CheckStatusBadge({ status }: { status: AgentReadinessCheckStatus }) {
  return <Badge className={CHECK_STATUS_CLASS[status]}>{CHECK_STATUS_LABEL[status]}</Badge>;
}

function subjectKey(subject: Pick<AgentReadinessSubjectSummary, "subjectType" | "subjectId">) {
  return `${subject.subjectType}:${subject.subjectId}`;
}

function subjectIcon(subject: AgentReadinessSubjectSummary) {
  if (subject.subjectType === "company") return Users;
  if (subject.subjectType === "bot") return Bot;
  return ShieldCheck;
}

function subjectProviderLabel(provider: string | null): string | null {
  if (!provider) return null;
  if (provider === "grok_bot_twin") return "Grok twin";
  return provider;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function levelTone(status: AgentReadinessLevelResult["status"]): string {
  switch (status) {
    case "pass": return "text-foreground";
    case "fail": return "text-destructive";
    case "unverified": return "text-muted-foreground";
    case "skipped": return "text-muted-foreground/60";
  }
}

function LevelStatusMark({ status }: { status: AgentReadinessLevelResult["status"] }) {
  if (status === "pass") return <CheckCircle2 aria-hidden className="size-4 text-foreground" />;
  if (status === "fail") return <CircleAlert aria-hidden className="size-4 text-destructive" />;
  if (status === "unverified") return <CircleSlash2 aria-hidden className="size-4 text-muted-foreground" />;
  return <CircleSlash2 aria-hidden className="size-4 text-muted-foreground/60" />;
}

function findingOrder(finding: AgentReadinessFinding): number {
  const index = AGENT_READINESS_CHECKS.findIndex((check) => check.id === finding.checkId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function SubjectTable({
  subjects,
  selectedKey,
  onSelect,
}: {
  subjects: AgentReadinessSubjectSummary[];
  selectedKey: string | null;
  onSelect: (subject: AgentReadinessSubjectSummary) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table aria-label="Readiness subjects" className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-2 pr-4 font-medium">Subject</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Levels</th>
            <th className="py-2 font-medium">Must-pass</th>
          </tr>
        </thead>
        <tbody>
          {subjects.map((subject) => {
            const Icon = subjectIcon(subject);
            const active = selectedKey === subjectKey(subject);
            const passedLevels = subject.levels.filter((level) => level.status === "pass").length;
            const applicableLevels = subject.levels.filter((level) => level.status !== "skipped").length;
            const mustPassFailed = subject.levels.some((level) => level.mustPassFailed);
            return (
              <tr
                key={subjectKey(subject)}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                onClick={() => onSelect(subject)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(subject);
                  }
                }}
                className={active ? "cursor-pointer border-b border-border bg-muted/60" : "cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/40"}
              >
                <td className="py-2 pr-4">
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium text-foreground">{subject.name}</span>
                    {subject.grokBotTwin
                      ? <Badge variant="outline">Grok twin</Badge>
                      : subjectProviderLabel(subject.provider)
                        ? <Badge variant="outline">{subjectProviderLabel(subject.provider)}</Badge>
                        : null}
                  </span>
                </td>
                <td className="py-2 pr-4 text-muted-foreground">{subject.subjectType === "bot" ? "Bot" : subject.subjectType === "company" ? "Company" : "Agent"}</td>
                <td className="py-2 pr-4"><StatusBadge status={subject.status} /></td>
                <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                  {passedLevels}/{applicableLevels}
                </td>
                <td className="py-2">
                  {mustPassFailed
                    ? <Badge className={CHECK_STATUS_CLASS.fail}>Failing</Badge>
                    : <span className="text-xs text-muted-foreground">Clear</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SubjectSection({
  title,
  subjects,
  selectedKey,
  onSelect,
}: {
  title: string;
  subjects: AgentReadinessSubjectSummary[];
  selectedKey: string | null;
  onSelect: (subject: AgentReadinessSubjectSummary) => void;
}) {
  if (subjects.length === 0) return null;
  return (
    <section aria-label={title} data-readiness-section={title.toLowerCase()}>
      <h3 className="mb-2 text-sm font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">({subjects.length})</span>
      </h3>
      <SubjectTable subjects={subjects} selectedKey={selectedKey} onSelect={onSelect} />
    </section>
  );
}

function AttestForm({
  finding,
  pending,
  onAttest,
}: {
  finding: AgentReadinessFinding;
  pending: boolean;
  onAttest: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const trimmedNote = note.trim();
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmedNote) return;
        onAttest(trimmedNote);
      }}
    >
      <Input
        aria-label={`Attestation note for ${finding.title}`}
        placeholder="What did you check?"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="h-8 min-w-0 flex-1"
      />
      <Button type="submit" size="sm" disabled={pending || !trimmedNote}>
        {pending ? "Saving" : "Attest"}
      </Button>
    </form>
  );
}

function FindingRow({
  finding,
  pendingFix,
  pendingAttest,
  onFix,
  onAttest,
}: {
  finding: AgentReadinessFinding;
  pendingFix: boolean;
  pendingAttest: boolean;
  onFix: (finding: AgentReadinessFinding) => void;
  onAttest: (finding: AgentReadinessFinding, note: string) => void;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const fix = finding.fix;
  const canFix = Boolean(fix) && finding.status !== "pass";
  const canAttest = finding.kind === "manual" && finding.status !== "pass";
  return (
    <li className="border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{finding.title}</span>
            <CheckStatusBadge status={finding.status} />
            {finding.severity === "must_pass" ? <Badge variant="outline">Must-pass</Badge> : null}
            <Badge variant="outline">{finding.kind}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{finding.message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {finding.deepLink ? (
              <Button asChild variant="link" size="xs">
                <Link to={finding.deepLink.path}>{finding.deepLink.label}</Link>
              </Button>
            ) : null}
            {finding.evidence ? (
              <Button type="button" variant="ghost" size="xs" onClick={() => setShowEvidence((current) => !current)}>
                {showEvidence ? "Hide evidence" : "Show evidence"}
              </Button>
            ) : null}
            {canFix && fix ? (
              <Button type="button" variant="outline" size="xs" disabled={pendingFix} onClick={() => onFix(finding)}>
                {pendingFix ? "Checking" : fix.label}
              </Button>
            ) : null}
          </div>
          {showEvidence && finding.evidence ? (
            <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs text-muted-foreground">
              {JSON.stringify(finding.evidence, null, 2)}
            </pre>
          ) : null}
          {canAttest ? (
            <AttestForm finding={finding} pending={pendingAttest} onAttest={(note) => onAttest(finding, note)} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SubjectDetail({
  subject,
  findings,
  reportId,
  fixPending,
  attestPending,
  onFix,
  onAttest,
  onClose,
}: {
  subject: AgentReadinessSubjectSummary;
  findings: AgentReadinessFinding[];
  reportId: string | null;
  fixPending: boolean;
  attestPending: boolean;
  onFix: (finding: AgentReadinessFinding) => void;
  onAttest: (finding: AgentReadinessFinding, note: string) => void;
  onClose: () => void;
}) {
  const Icon = subjectIcon(subject);
  const byLevel = useMemo(() => {
    const grouped = new Map<number, AgentReadinessFinding[]>();
    for (const finding of [...findings].sort((a, b) => findingOrder(a) - findingOrder(b))) {
      const list = grouped.get(finding.level) ?? [];
      list.push(finding);
      grouped.set(finding.level, list);
    }
    return [...grouped.entries()].sort(([a], [b]) => a - b);
  }, [findings]);
  return (
    <SidePanelFrame
      open
      presentation="embedded"
      contentMode="padded"
      label={`Readiness detail for ${subject.name}`}
      className="h-auto"
      header={(
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold text-foreground">{subject.name}</span>
          <StatusBadge status={subject.status} />
        </div>
      )}
      trailingControls={(
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Close readiness detail" onClick={onClose}>
          <X aria-hidden />
        </Button>
      )}
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {subject.subjectType === "company" ? "Company-wide checks" : subject.subjectType === "bot" ? "Bot checks" : "Agent checks"}
            {subjectProviderLabel(subject.provider) ? ` · ${subjectProviderLabel(subject.provider)}` : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            {subject.levels.filter((level) => level.status !== "skipped").map((level) => (
              <Badge key={level.level} variant="outline" className={levelTone(level.status)}>
                {level.level}. {level.passed}/{level.applicable}
              </Badge>
            ))}
          </div>
        </div>
        {byLevel.length === 0 ? (
          <p className="text-sm text-muted-foreground">No findings for this subject.</p>
        ) : byLevel.map(([level, levelFindings]) => (
          <section key={level} aria-label={agentReadinessLevelName(level)}>
            <h3 className="mb-1 text-sm font-semibold text-foreground">
              Level {level} · {agentReadinessLevelName(level)}
            </h3>
            <ul>
              {levelFindings.map((finding) => (
                <FindingRow
                  key={`${finding.subjectType}:${finding.subjectId}:${finding.checkId}`}
                  finding={finding}
                  pendingFix={fixPending}
                  pendingAttest={attestPending}
                  onFix={onFix}
                  onAttest={onAttest}
                />
              ))}
            </ul>
          </section>
        ))}
        {reportId ? <p className="text-xs text-muted-foreground">Report {reportId}</p> : null}
      </div>
    </SidePanelFrame>
  );
}

function SummaryCount({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={tone ? `text-2xl font-semibold ${tone}` : "text-2xl font-semibold text-foreground"}>{value}</p>
    </div>
  );
}

export function AgentReadiness() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agentReadiness.report(selectedCompanyId);
  const reportQuery = useQuery({
    queryKey,
    queryFn: () => agentReadinessApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const [query, setQuery] = useState("");
  // undefined means "no choice yet, show the first result"; null means the detail
  // pane was closed on purpose and must stay closed.
  const [selectedKey, setSelectedKey] = useState<string | null | undefined>(undefined);
  const [fixPending, setFixPending] = useState<string | null>(null);
  const [attestPending, setAttestPending] = useState<string | null>(null);

  const report = reportQuery.data ?? null;
  const subjects = report?.summary.subjects ?? [];
  const filteredSubjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return subjects;
    return subjects.filter((subject) =>
      `${subject.name} ${subject.subjectType} ${subject.provider ?? ""} ${subjectProviderLabel(subject.provider) ?? ""} ${subject.grokBotTwin ? "grok twin" : ""}`.toLowerCase().includes(needle));
  }, [query, subjects]);
  // Bots and agents are one taxonomy but different operating concerns: a twin is
  // a chat bot with a Hermes profile, not a paperclip-native agent. The company is
  // its own row and stays visible in every split.
  const companySubjects = useMemo(() => filteredSubjects.filter((subject) => subject.subjectType === "company"), [filteredSubjects]);
  const botSubjects = useMemo(() => filteredSubjects.filter((subject) => subject.subjectType === "bot"), [filteredSubjects]);
  const agentSubjects = useMemo(() => filteredSubjects.filter((subject) => subject.subjectType === "agent"), [filteredSubjects]);
  const selected = selectedKey === null
    ? null
    : selectedKey !== undefined
      ? subjects.find((subject) => subjectKey(subject) === selectedKey) ?? null
      : filteredSubjects[0] ?? subjects[0] ?? null;
  const selectedFindings = useMemo(() => selected
    ? report?.findings.filter((finding) =>
      finding.subjectType === selected.subjectType && finding.subjectId === selected.subjectId) ?? []
    : [], [report, selected]);

  const runMutation = useMutation({
    mutationFn: (includeLive: boolean) => agentReadinessApi.run(selectedCompanyId!, includeLive),
    onSuccess: (nextReport) => {
      queryClient.setQueryData(queryKey, nextReport);
      pushToast({
        title: nextReport.includeLive ? "Live readiness checks finished" : "Readiness checks finished",
        tone: nextReport.summary.status === "blocked" ? "error" : "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Readiness checks could not run",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const fixMutation = useMutation({
    mutationFn: (finding: AgentReadinessFinding) => {
      if (!finding.fix) throw new Error("This finding has no fix");
      return agentReadinessApi.fix(selectedCompanyId!, {
        reportId: report?.id ?? null,
        subjectType: finding.subjectType,
        subjectId: finding.subjectId,
        checkId: finding.checkId,
        action: finding.fix.action,
        confirm: true,
      });
    },
    onMutate: (finding) => {
      setFixPending(`${finding.subjectType}:${finding.subjectId}:${finding.checkId}`);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result.report);
      pushToast({ title: result.message, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "The readiness fix failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
    onSettled: () => setFixPending(null),
  });

  const attestMutation = useMutation({
    mutationFn: ({ finding, note }: { finding: AgentReadinessFinding; note: string }) =>
      agentReadinessApi.attest(selectedCompanyId!, {
        subjectType: finding.subjectType,
        subjectId: finding.subjectId,
        checkId: finding.checkId,
        note,
      }),
    onMutate: ({ finding }) => {
      setAttestPending(`${finding.subjectType}:${finding.subjectId}:${finding.checkId}`);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result.report);
      pushToast({ title: "Readiness check attested", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "The attestation failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
    onSettled: () => setAttestPending(null),
  });

  if (!selectedCompanyId) {
    return (
      <div className="p-4">
        <EmptyState icon={ShieldCheck} title="Select a company" message="Choose a company to check its agents and bots." />
      </div>
    );
  }

  if (reportQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <RefreshCw aria-hidden className="size-4 animate-spin" />
        Building the readiness report…
      </div>
    );
  }

  if (reportQuery.isError || !report) {
    return (
      <div className="p-4">
        <EmptyState
          icon={CircleAlert}
          title="Readiness is unavailable"
          message={reportQuery.error instanceof Error ? reportQuery.error.message : "The readiness report could not be loaded."}
          action="Retry"
          onAction={() => void reportQuery.refetch()}
          hideActionIcon
        />
      </div>
    );
  }

  const running = runMutation.isPending;
  const allFindings = report.findings.length;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <ShieldCheck aria-hidden className="size-6" />
            Readiness
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Static checks run on load. Live probes authenticate with each agent&apos;s saved setup and only run when a board member asks.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={report.summary.status} />
          <span className="text-xs text-muted-foreground">Last run {formatTimestamp(report.completedAt)}</span>
          <Button type="button" variant="outline" disabled={running} onClick={() => runMutation.mutate(false)}>
            <RefreshCw aria-hidden className={running ? "animate-spin" : ""} />
            Run checks
          </Button>
          <Button type="button" disabled={running} onClick={() => runMutation.mutate(true)}>
            <Activity aria-hidden />
            Run with live probes
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-6 pt-2">
          <SummaryCount label="Subjects" value={report.summary.subjectCount} />
          <SummaryCount label="Ready" value={report.summary.subjectCounts.ready} />
          <SummaryCount label="Needs attention" value={report.summary.subjectCounts.attention} />
          <SummaryCount label="Blocked" value={report.summary.subjectCounts.blocked} tone="text-destructive" />
          <SummaryCount label="Unverified" value={report.summary.subjectCounts.unverified} tone="text-muted-foreground" />
          <SummaryCount label="Findings" value={allFindings} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4 xl:flex-row">
        <div className="min-w-0 flex-1 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Levels 1–13</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ul>
                {report.summary.levels.map((level) => (
                  <li key={level.level} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 last:border-b-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <LevelStatusMark status={level.status} />
                      <span className="w-6 text-xs text-muted-foreground">{level.level}</span>
                      <span className={levelTone(level.status)}>{level.name}</span>
                      {MUST_PASS_LEVELS.has(level.level) ? <Badge variant="outline">Must-pass</Badge> : null}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      {level.status === "skipped" ? <span>Not applicable</span> : (
                        <span className="font-mono">{level.passed}/{level.applicable} · {Math.round(level.passRate * 100)}%</span>
                      )}
                      {level.mustPassFailed ? <span className="text-destructive">Must-pass failed</span> : null}
                      {level.status === "unverified" ? <span>Unverified</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm">Agents and bots</CardTitle>
              <div className="w-full max-w-sm">
                <ToolbarSearch
                  query={query}
                  onQueryChange={setQuery}
                  label="Search readiness subjects"
                  placeholder="Search agents and bots"
                />
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {filteredSubjects.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No subject matches this search.</p>
              ) : (
                <div className="space-y-6">
                  <SubjectSection
                    title="Company"
                    subjects={companySubjects}
                    selectedKey={selected ? subjectKey(selected) : null}
                    onSelect={(subject) => setSelectedKey(subjectKey(subject))}
                  />
                  <SubjectSection
                    title="Bots"
                    subjects={botSubjects}
                    selectedKey={selected ? subjectKey(selected) : null}
                    onSelect={(subject) => setSelectedKey(subjectKey(subject))}
                  />
                  <SubjectSection
                    title="Agents"
                    subjects={agentSubjects}
                    selectedKey={selected ? subjectKey(selected) : null}
                    onSelect={(subject) => setSelectedKey(subjectKey(subject))}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {selected ? (
          <div className="w-full shrink-0 xl:w-96">
            <SubjectDetail
              subject={selected}
              findings={selectedFindings}
              reportId={report.id}
              fixPending={Boolean(fixPending)}
              attestPending={Boolean(attestPending)}
              onFix={(finding) => fixMutation.mutate(finding)}
              onAttest={(finding, note) => attestMutation.mutate({ finding, note })}
              onClose={() => setSelectedKey(null)}
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Wrench aria-hidden className="size-3" />
        <span>Fixes are safe and idempotent. Everything else links to the exact settings panel.</span>
        {report.includeLive ? <Badge variant="outline">Live probes included</Badge> : <Badge variant="outline">Static only</Badge>}
      </div>
    </div>
  );
}

export default AgentReadiness;
