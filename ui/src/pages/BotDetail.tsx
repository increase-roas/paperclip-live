import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyBotDetail } from "@paperclipai/shared";
import { ArrowLeft, Bot, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { StatusBadge } from "@/components/StatusBadge";
import { Link, useNavigate, useParams } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { botStatusLabel } from "@/lib/bot-status";
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
      <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <RefreshCw aria-hidden className="size-4 animate-spin" />
        Loading bot…
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
  if (!bot) {
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
  const description = bot.purpose ?? bot.note;

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
            <BotStatus status={bot.status} />
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {bot.registered
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
            <dl
              className="grid gap-y-2 text-xs"
              style={{ gridTemplateColumns: "var(--sz-6rem) 1fr" }}
            >
              <dt className="text-muted-foreground">Key id</dt>
              <dd className="font-mono break-all text-foreground">{bot.gateway.keyId}</dd>
              <dt className="text-muted-foreground">Policy</dt>
              <dd><Badge variant="outline">{bot.gateway.policy}</Badge></dd>
              <dt className="text-muted-foreground">Provider</dt>
              <dd className="break-all text-foreground">{bot.gateway.provider ?? "—"}</dd>
            </dl>
          ) : (
            <p className="text-muted-foreground">
              {bot.registered
                ? "Not linked. Add the gateway key id and policy to this agent's metadata under bot.gateway."
                : "No gateway key is linked to this bot yet. Register the bot to record its key id and policy."}
            </p>
          )}
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
            {bot.recentActivity.length === 0 ? (
              <p className="text-muted-foreground">
                {bot.registered
                  ? "No recorded activity. Runs and agent actions will appear here."
                  : "No recorded activity."}
              </p>
            ) : (
              <ul className="flex flex-col text-xs">
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
