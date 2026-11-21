import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, CircleAlert, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { Link, useParams } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { botsApi } from "@/api/bots";

function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Never" : formatDateTime(parsed);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 text-sm">{children}</CardContent>
    </Card>
  );
}

export function BotDetail() {
  const { botId = "" } = useParams<{ botId?: string }>();
  const { selectedCompanyId } = useCompany();
  const botQuery = useQuery({
    queryKey: queryKeys.bots.detail(selectedCompanyId, botId),
    queryFn: () => botsApi.get(selectedCompanyId!, botId),
    enabled: Boolean(selectedCompanyId && botId),
  });

  if (!selectedCompanyId) {
    return (
      <div className="p-4">
        <EmptyState icon={Bot} title="Select a company" message="Choose a company to open its bots." />
      </div>
    );
  }

  if (botQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <RefreshCw aria-hidden className="size-4 animate-spin" />
        Loading bot…
      </div>
    );
  }

  if (botQuery.isError || !botQuery.data) {
    return (
      <div className="p-4">
        <EmptyState
          icon={CircleAlert}
          title="This bot is unavailable"
          message={botQuery.error instanceof Error ? botQuery.error.message : "The bot could not be loaded."}
          action="Retry"
          onAction={() => void botQuery.refetch()}
          hideActionIcon
        />
      </div>
    );
  }

  const bot = botQuery.data;

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
            <Badge variant="outline">{bot.status}</Badge>
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="What it does">
          <p>{bot.purpose ?? "No purpose recorded yet."}</p>
          <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-1 text-xs text-muted-foreground">
            <dt>Role</dt>
            <dd className="text-foreground">{bot.role ?? "—"}</dd>
            <dt>Title</dt>
            <dd className="text-foreground">{bot.title ?? "—"}</dd>
            <dt>Adapter</dt>
            <dd className="font-mono text-foreground">{bot.adapterType ?? "—"}</dd>
          </dl>
          {bot.note ? <p className="mt-3 text-xs text-muted-foreground">{bot.note}</p> : null}
        </Section>

        <Section title="Gateway key and policy">
          {bot.gateway ? (
            <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-xs">
              <dt className="text-muted-foreground">Key id</dt>
              <dd className="font-mono text-foreground">{bot.gateway.keyId}</dd>
              <dt className="text-muted-foreground">Policy</dt>
              <dd><Badge variant="outline">{bot.gateway.policy}</Badge></dd>
              <dt className="text-muted-foreground">Provider</dt>
              <dd className="text-foreground">{bot.gateway.provider ?? "—"}</dd>
            </dl>
          ) : (
            <p className="text-muted-foreground">
              {bot.registered
                ? "Not linked. Add the gateway key id and policy to this agent's metadata under bot.gateway."
                : "No gateway key is linked to this bot yet."}
            </p>
          )}
        </Section>

        <Section title="Routines and schedules">
          {bot.routines.length === 0 ? (
            <p className="text-muted-foreground">No routines assigned.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {bot.routines.map((routine) => (
                <li key={routine.id}>
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{routine.title}</span>
                    <Badge variant="outline">{routine.status}</Badge>
                  </p>
                  {routine.triggers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No active trigger.</p>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                      {routine.triggers.map((trigger, index) => (
                        <li key={`${routine.id}-${index}`} className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-foreground">{trigger.kind}</span>
                          {trigger.cronExpression ? <span className="font-mono">{trigger.cronExpression}</span> : null}
                          {trigger.timezone ? <span>{trigger.timezone}</span> : null}
                          <span>{trigger.enabled ? "enabled" : "disabled"}</span>
                          <span>next {formatTimestamp(trigger.nextRunAt)}</span>
                          <span>last {formatTimestamp(trigger.lastFiredAt)}</span>
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
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{bot.status}</Badge>
            <span className="text-xs text-muted-foreground">
              {bot.registered ? `Updated ${formatTimestamp(bot.updatedAt)}` : "Not registered"}
            </span>
          </p>
        </Section>

        <div className="lg:col-span-2">
          <Section title="Recent activity">
            {bot.recentActivity.length === 0 ? (
              <p className="text-muted-foreground">No recorded activity.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs">
                {bot.recentActivity.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-2 border-b border-border py-1 last:border-b-0">
                    <span className="font-mono text-foreground">{entry.action}</span>
                    <span className="text-muted-foreground">
                      {entry.entityType} {entry.entityId}
                    </span>
                    <span className="ml-auto text-muted-foreground">{formatTimestamp(entry.createdAt)}</span>
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
