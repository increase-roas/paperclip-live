import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyBotDetail, CompanyGatewayBotSummary, GatewayBotPolicy } from "@paperclipai/shared";
import { ArrowLeft, Bot, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState, QueryPlaceholder, useQueryView } from "@/components/QueryView";
import { StatusBadge } from "@/components/StatusBadge";
import { Link, useNavigate, useParams } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { botStatusLabel } from "@/lib/bot-status";
import { botNeedsInput } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { botsApi } from "@/api/bots";

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : formatDateTime(parsed);
}

/** Timestamps are machine values: render them in the monospace token. */
function Timestamp({ value, fallback = "Never" }: { value: string | null; fallback?: string }) {
  const formatted = formatTimestamp(value);
  if (!formatted || !value) return <span className="text-muted-foreground">{fallback}</span>;
  return (
    <time dateTime={value} className="font-mono">
      {formatted}
    </time>
  );
}

/** Bot state in the shared agent status vocabulary, with a readable label. */
function BotStatus({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="sr-only">Status:</span>
      <StatusBadge status={status} label={botStatusLabel(status)} />
    </span>
  );
}

function RegisterPanel({ bot }: { bot: CompanyBotDetail }) {
  const registered = bot.registered && bot.agentId;
  return (
    <Section title={registered ? "Link a gateway key" : "How to register"}>
      <ol className="list-decimal space-y-2 pl-4">
        <li>
          Tag the agent as a bot in its metadata: <code className="font-mono text-xs">grokBotTwin: true</code> for a
          Hermes twin, or <code className="font-mono text-xs">agentKind: &quot;bot&quot;</code> for any other bot.
        </li>
        <li>
          Record the gateway link in the same metadata: <code className="font-mono text-xs">bot.gateway.keyId</code>{" "}
          and <code className="font-mono text-xs">bot.gateway.policy</code>. The key itself stays in the gateway.
        </li>
      </ol>
      <pre className="mt-3 overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-5 text-foreground">
{`{
  "grokBotTwin": true,
  "bot": {
    "purpose": "What this bot does.",
    "gateway": { "keyId": "gk_live_...", "policy": "website-builder" }
  }
}`}
      </pre>
      <Button asChild variant="outline" className="mt-3">
        <Link to={registered ? `/agents/${bot.agentId}` : "/agents/new"}>
          {registered ? "Open the agent to add the key" : "Create the bot agent"}
        </Link>
      </Button>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm leading-none font-semibold">{title}</h2>
      </CardHeader>
      <CardContent className="pt-0 text-sm">{children}</CardContent>
    </Card>
  );
}

const GATEWAY_CAPABILITIES: Array<[string, (policy: GatewayBotPolicy) => boolean]> = [
  ["outbound", (policy) => policy.allowOutbound],
  ["delete", (policy) => policy.allowDelete],
  ["agency write", (policy) => policy.allowAgencyWrite],
  ["bulk", (policy) => policy.allowBulk],
  ["spend", (policy) => policy.allowSpend],
  ["build", (policy) => policy.allowBuild],
];

/**
 * Live gateway data is optional. When the operator has not turned it on, or the
 * gateway is unreachable, the page keeps the metadata it already has and says
 * so plainly instead of showing an empty or broken panel.
 */
function GatewayLiveData({
  gateway,
  isFetching,
  failed,
}: {
  gateway?: CompanyGatewayBotSummary;
  isFetching: boolean;
  failed: boolean;
}) {
  if (failed) {
    return (
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
        Live gateway data is unavailable right now. The roster above comes from agent records.
      </p>
    );
  }
  if (!gateway) {
    return isFetching ? (
      <p className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground" role="status">
        <RefreshCw aria-hidden className="size-3 animate-spin" />
        Reading gateway key and usage…
      </p>
    ) : null;
  }
  if (!gateway.connected) {
    return (
      <div className="mt-3 border-t border-border pt-3 text-xs">
        <p className="font-medium text-foreground">Gateway not connected</p>
        <p className="mt-1 text-muted-foreground">{gateway.message}</p>
      </div>
    );
  }

  const summary = gateway.summary;
  const allowed = GATEWAY_CAPABILITIES.filter(([, on]) => on(summary.policy)).map(([name]) => name);
  const providers = summary.grantedProviders.length > 0 ? summary.grantedProviders.join(", ") : "None granted";

  return (
    <div className="mt-3 border-t border-border pt-3 text-xs">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">Live gateway</span>
        <Badge variant="outline">{summary.enabled ? "key enabled" : "key disabled"}</Badge>
        {summary.policy.admin ? <Badge variant="outline">admin</Badge> : null}
        {summary.preset ? <Badge variant="outline">{summary.preset.name}</Badge> : null}
      </p>
      <dl className="mt-2 grid gap-y-1" style={{ gridTemplateColumns: "var(--sz-6rem) 1fr" }}>
        <dt className="text-muted-foreground">Fingerprint</dt>
        <dd className="font-mono break-all text-foreground">{summary.key.fingerprint ?? "No key stored"}</dd>
        <dt className="text-muted-foreground">Key created</dt>
        <dd className="text-foreground"><Timestamp value={summary.key.createdAt} fallback="—" /></dd>
        <dt className="text-muted-foreground">Rotated</dt>
        <dd className="text-foreground"><Timestamp value={summary.key.rotatedAt} fallback="Never" /></dd>
        <dt className="text-muted-foreground">Mode</dt>
        <dd className="text-foreground">{summary.policy.mode ?? "—"}{summary.policy.role ? ` · ${summary.policy.role}` : ""}</dd>
        <dt className="text-muted-foreground">Allows</dt>
        <dd className="text-foreground">{allowed.length > 0 ? allowed.join(", ") : "Read only"}</dd>
        <dt className="text-muted-foreground">Providers</dt>
        <dd className="break-all text-foreground">{providers}</dd>
        <dt className="text-muted-foreground">Last 24h</dt>
        <dd className="text-foreground">
          <span className="font-mono">{summary.usage.last24h.requests}</span> requests,{" "}
          <span className="font-mono">{summary.usage.last24h.errors}</span> errors
        </dd>
        <dt className="text-muted-foreground">Last 7d</dt>
        <dd className="text-foreground">
          <span className="font-mono">{summary.usage.last7d.requests}</span> requests,{" "}
          <span className="font-mono">{summary.usage.last7d.errors}</span> errors
        </dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd className="text-foreground"><Timestamp value={summary.usage.lastUsedAt} fallback="Never" /></dd>
      </dl>
      {summary.policy.secrets.length > 0 ? (
        <p className="mt-2 text-muted-foreground">
          Secret names: <span className="font-mono text-foreground">{summary.policy.secrets.join(", ")}</span>
        </p>
      ) : null}
      {summary.preset?.description ? <p className="mt-2 text-muted-foreground">{summary.preset.description}</p> : null}
    </div>
  );
}

export function BotDetail() {
  const { botId = "" } = useParams<{ botId?: string }>();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const botQuery = useQuery({
    queryKey: queryKeys.bots.detail(selectedCompanyId, botId),
    queryFn: () => botsApi.get(selectedCompanyId!, botId),
    enabled: Boolean(selectedCompanyId && botId),
  });
  // Live gateway key, policy and usage. The server answers "not connected"
  // when the operator has not enabled gateway reads, so this never fails the
  // page or exposes a key.
  const gatewayQuery = useQuery({
    queryKey: queryKeys.bots.gatewaySummary(selectedCompanyId, botId),
    queryFn: () => botsApi.gatewaySummary(selectedCompanyId!, botId),
    enabled: Boolean(selectedCompanyId && botId),
    retry: false,
    staleTime: 30_000,
  });
  const botsHref = selectedCompany?.issuePrefix ? `/${selectedCompany.issuePrefix}/bots` : "/bots";

  useEffect(() => {
    setBreadcrumbs([
      { label: "Bots", href: botsHref },
      { label: botQuery.data?.name ?? "Bot" },
    ]);
  }, [botQuery.data?.name, botsHref, setBreadcrumbs]);

  const botView = useQueryView(botQuery);

  if (!selectedCompanyId) {
    return (
      <div className="p-4">
        <EmptyState icon={Bot} title="Select a company" message="Choose a company to open its bots." />
      </div>
    );
  }

  if (botView.kind === "loading" || botView.kind === "reconnecting") {
    return (
      <div className="p-4">
        <QueryPlaceholder size="page" label="Loading bot" />
      </div>
    );
  }

  if (botView.kind === "error") {
    if (botView.errorKind === "not_found") {
      return (
        <div className="p-4">
          <EmptyState
            icon={Bot}
            title="Bot not found"
            message="This bot is not in the company roster. Check the link, or open Bots to see the bots this company runs."
            action="Open Bots"
            onAction={() => navigate("/bots")}
            hideActionIcon
          />
        </div>
      );
    }
    return (
      <QueryErrorState
        size="page"
        error={botView.error}
        action="load this bot"
        onRetry={botView.retry}
        retrying={botView.isFetching}
      />
    );
  }

  const bot = botView.data;
  if (!bot) return null;
  const needsInput = botNeedsInput(bot);
  const description = bot.purpose ?? bot.note;
  // Gateway audit rows are body-free: method, path, status and time only.
  const gatewayAudit = gatewayQuery.data?.connected ? gatewayQuery.data.summary.audit.slice(0, 10) : [];

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <Button asChild variant="link" size="xs" className="px-0">
          <Link to="/bots">
            <ArrowLeft aria-hidden />
            All bots
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-foreground">
            <Bot aria-hidden className="size-6" />
            {bot.name}
            {bot.grokBotTwin ? <Badge variant="outline">Grok twin</Badge> : null}
            <Badge variant="outline">{bot.kind === "gateway" ? "Gateway bot" : "Agent bot"}</Badge>
            {bot.taggedAsBot === false && bot.agentId ? <Badge variant="outline">Not tagged as a bot</Badge> : null}
            <BotStatus status={bot.status} />
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {bot.taggedAsBot === false && bot.agentId
              ? "This Hermes gateway agent has no bot metadata yet, so it is not in the registered roster. Its routines, status and activity still come from the agent."
              : bot.registered
                ? "Registered in this company. Gateway key ids are identifiers; the key itself stays in the gateway."
                : "Known bot with no Paperclip agent row yet. Register it to give it a status, routines and activity."}
          </p>
        </div>
        {bot.agentId ? (
          <Button asChild variant="outline">
            <Link to={`/agents/${bot.agentId}`}>Open agent</Link>
          </Button>
        ) : null}
      </div>

      {!bot.gateway ? (
        <div>
          <RegisterPanel bot={bot} />
        </div>
      ) : null}

      {needsInput.length > 0 ? (
        <Section title={`Needs owner input (${needsInput.length})`}>
          <p className="text-muted-foreground">
            These rows stay unknown until someone records them. Nothing here is guessed.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {needsInput.map((need) => (
              <li key={need.kind} className="text-sm">
                <span className="font-semibold text-foreground">{need.label}:</span> {need.detail}{" "}
                <code className="font-mono text-xs text-muted-foreground">{need.metadataKey}</code>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="What it does">
          <p>{description ?? "No purpose recorded yet. Add it to the bot metadata so operators know what this bot does."}</p>
          {bot.purpose && bot.note ? <p className="mt-3 text-xs text-muted-foreground">{bot.note}</p> : null}
          {bot.registered ? (
            <dl
              className="mt-3 grid gap-y-1 text-xs text-muted-foreground"
              style={{ gridTemplateColumns: "var(--sz-7rem) 1fr" }}
            >
              <dt>Role</dt>
              <dd className="text-foreground">{bot.role ?? "—"}</dd>
              <dt>Title</dt>
              <dd className="text-foreground">{bot.title ?? "—"}</dd>
              <dt>Adapter</dt>
              <dd className="font-mono break-all text-foreground">{bot.adapterType ?? "—"}</dd>
            </dl>
          ) : null}
        </Section>

        <Section title="Gateway key and policy">
          {bot.gateway ? (
            <>
              <dl
                className="grid gap-y-2 text-xs"
                style={{ gridTemplateColumns: "var(--sz-6rem) 1fr" }}
              >
                <dt className="text-muted-foreground">Key id</dt>
                <dd className="font-mono break-all text-foreground">
                  {bot.gateway.keyId ?? <span className="text-muted-foreground">Key id not recorded</span>}
                </dd>
                <dt className="text-muted-foreground">Policy</dt>
                <dd><Badge variant="outline">{bot.gateway.policy}</Badge></dd>
                <dt className="text-muted-foreground">Provider</dt>
                <dd className="break-all text-foreground">{bot.gateway.provider ?? "—"}</dd>
              </dl>
              {bot.gateway.source === "agent_config" ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Policy read from this agent&apos;s gateway URL. The key id is not recorded in Paperclip, so
                  add it to the agent&apos;s metadata under bot.gateway when you have it.
                </p>
              ) : null}
              {bot.gateway.source === "catalog_preset" ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Policy from the gateway preset this bot ships with. Register the bot to record its key id.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">
              {bot.registered
                ? "Not linked. Add the gateway key id and policy to this agent's metadata under bot.gateway."
                : "No gateway key is linked to this bot yet. Register the bot to record its key id and policy."}
            </p>
          )}
          <GatewayLiveData
            gateway={gatewayQuery.data}
            isFetching={gatewayQuery.isFetching}
            failed={gatewayQuery.isError}
          />
        </Section>

        <Section title="Routines and schedules">
          {bot.routines.length === 0 ? (
            <p className="text-muted-foreground">
              {bot.registered
                ? "No routines assigned. Assign a routine to schedule this bot's work."
                : "No routines assigned."}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {bot.routines.map((routine) => (
                <li key={routine.id}>
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{routine.title}</span>
                    <Badge variant="outline">{botStatusLabel(routine.status)}</Badge>
                  </p>
                  {routine.triggers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No active trigger.</p>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                      {routine.triggers.map((trigger, index) => (
                        <li key={`${routine.id}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-mono text-foreground">{trigger.kind}</span>
                          {trigger.cronExpression ? <span className="font-mono">{trigger.cronExpression}</span> : null}
                          {trigger.timezone ? <span>{trigger.timezone}</span> : null}
                          <span>{trigger.enabled ? "enabled" : "disabled"}</span>
                          {trigger.nextRunAt ? (
                            <span>
                              next <Timestamp value={trigger.nextRunAt} />
                            </span>
                          ) : (
                            <span>no next run</span>
                          )}
                          {trigger.lastFiredAt ? (
                            <span>
                              last <Timestamp value={trigger.lastFiredAt} />
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Status">
          <div className="flex flex-wrap items-center gap-2">
            <BotStatus status={bot.status} />
            <span className="text-xs text-muted-foreground">
              {bot.registered ? (
                <>
                  Updated <Timestamp value={bot.updatedAt} fallback="never" />
                </>
              ) : (
                "No agent row yet, so there is no live status to report."
              )}
            </span>
          </div>
        </Section>

        <div className="lg:col-span-2">
          <Section title="Recent activity">
            {bot.recentActivity.length === 0 && gatewayAudit.length === 0 ? (
              <p className="text-muted-foreground">
                {bot.registered
                  ? "No recorded activity. Runs and agent actions will appear here."
                  : "No recorded activity."}
              </p>
            ) : (
              <ul className="flex flex-col text-xs">
                {gatewayAudit.map((entry) => (
                  <li
                    key={`gateway-${entry.id}`}
                    className="flex flex-col gap-1 border-b border-border py-2 first:pt-0 last:border-b-0 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge variant="outline">Gateway</Badge>
                      <span className="font-mono break-all text-foreground">
                        {entry.method} {entry.path}
                      </span>
                      <span className="min-w-0 break-all text-muted-foreground">
                        {entry.status} {entry.ok ? "ok" : "failed"}
                        {entry.source ? ` · ${entry.source}` : ""}
                      </span>
                    </span>
                    <span className="text-muted-foreground sm:ml-auto">
                      <Timestamp value={entry.at} />
                    </span>
                  </li>
                ))}
                {bot.recentActivity.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-col gap-1 border-b border-border py-2 first:pt-0 last:border-b-0 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge variant="outline">{entry.source === "run" ? "Run" : "Activity"}</Badge>
                      <span className="font-mono break-all text-foreground">{entry.action}</span>
                      <span className="min-w-0 break-all text-muted-foreground">
                        {entry.entityType} {entry.entityId}
                      </span>
                    </span>
                    <span className="text-muted-foreground sm:ml-auto">
                      <Timestamp value={entry.createdAt} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

export default BotDetail;
