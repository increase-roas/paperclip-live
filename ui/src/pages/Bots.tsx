import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, SearchX } from "lucide-react";
import type { BotRegistrationPlan, CompanyBotSummary, SuggestedAgentBot } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { StatusBadge } from "@/components/StatusBadge";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { Link, useNavigate } from "@/lib/router";
import { botStatusLabel } from "@/lib/bot-status";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { botsApi } from "@/api/bots";

function GatewayLine({ bot }: { bot: CompanyBotSummary }) {
  if (bot.gateway) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono break-all text-foreground">{bot.gateway.keyId}</span>
        <Badge variant="outline">{bot.gateway.policy}</Badge>
        {bot.gateway.provider ? <span className="break-all">{bot.gateway.provider}</span> : null}
      </span>
    );
  }
  if (!bot.registered) return null;
  return <span className="text-xs text-muted-foreground">Gateway key not linked.</span>;
}

function BotRow({ bot }: { bot: CompanyBotSummary }) {
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        to={`/bots/${bot.id}`}
        className="flex flex-col gap-1 rounded-md px-2 py-3 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Bot aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">{bot.name}</span>
          {bot.grokBotTwin ? <Badge variant="outline">Grok twin</Badge> : null}
          <Badge variant="outline">{bot.kind === "gateway" ? "Gateway bot" : "Agent bot"}</Badge>
          <StatusBadge status={bot.status} label={botStatusLabel(bot.status)} />
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {bot.purpose ?? bot.note ?? (bot.registered ? "No purpose recorded yet." : null)}
        </span>
        <GatewayLine bot={bot} />
      </Link>
    </li>
  );
}

function SuggestedAgentSection({ agents }: { agents: SuggestedAgentBot[] }) {
  if (agents.length === 0) return null;
  return (
    <section aria-label="Agents that look like bots" data-bots-suggestions="">
      <h3 className="mb-2 text-sm font-semibold text-foreground">
        Agents that look like bots <span className="font-normal text-muted-foreground">({agents.length})</span>
      </h3>
      <p className="mb-2 text-xs text-muted-foreground">
        These agents run on the Hermes gateway but are not tagged as bots yet. Add{" "}
        <code className="font-mono">grokBotTwin</code> or <code className="font-mono">agentKind: &quot;bot&quot;</code> to
        their metadata to move them into Bots.
      </p>
      <ul>
        {agents.map((agent) => (
          <li key={agent.agentId} className="border-b border-border last:border-b-0">
            <Link
              to={`/bots/${agent.agentId}`}
              className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="text-sm font-medium text-foreground">{agent.name}</span>
              <Badge variant="outline">{agent.adapterType}</Badge>
              <span className="text-xs text-muted-foreground">{agent.status}</span>
              <span className="ml-auto text-xs text-muted-foreground">Open bot page</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Read-only preview of the agent rows that catalog-bot registration would
 * create. Applying needs the operator runbook (`pnpm bots:register --apply`),
 * so the action here stays disabled on purpose.
 */
function RegistrationPlanSection({ plan }: { plan: BotRegistrationPlan | undefined }) {
  if (!plan || plan.entries.length === 0) return null;
  return (
    <section aria-label="Registration plan" data-bots-registration-plan="">
      <h3 className="mb-2 text-sm font-semibold text-foreground">
        Registration plan{" "}
        <span className="font-normal text-muted-foreground">
          ({plan.creates} to create{plan.skips > 0 ? `, ${plan.skips} skipped` : ""})
        </span>
      </h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Read-only. Registering creates a paused Hermes agent for each bot below, so it is not done from this page. The
        operator runbook is in <code className="font-mono">doc/bots.md</code> under “Registering a catalog bot”.
      </p>
      <ul>
        {plan.entries.map((entry) => (
          <li key={entry.slug} className="flex flex-col gap-1 border-b border-border px-2 py-2 last:border-b-0">
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{entry.action === "create" ? "Would create" : "Skipped"}</Badge>
              <span className="text-sm font-medium text-foreground">{entry.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{entry.slug}</span>
            </span>
            <span className="text-xs text-muted-foreground">{entry.reason}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled aria-describedby="bots-registration-disabled-reason">
          Apply registration
        </Button>
        <span id="bots-registration-disabled-reason" className="text-xs text-muted-foreground">
          Owner-only. Run <code className="font-mono">pnpm bots:register -- --apply</code> after Alex approves.
        </span>
      </div>
    </section>
  );
}

function BotSection({ title, bots }: { title: string; bots: CompanyBotSummary[] }) {
  if (bots.length === 0) return null;
  return (
    <section aria-label={title} data-bots-section={title.toLowerCase().replaceAll(" ", "-")}>
      <h3 className="mb-2 text-sm font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">({bots.length})</span>
      </h3>
      <ul>{bots.map((bot) => <BotRow key={bot.id} bot={bot} />)}</ul>
    </section>
  );
}

/** Holds the roster's shape while the first read lands, so the page does not jump. */
function BotsLoadingSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading bots" className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-full max-w-3xl" />
          <Skeleton className="h-4 w-3/4 max-w-2xl" />
        </div>
        <Skeleton className="h-10 w-full sm:w-80 sm:shrink-0" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-20" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          <Skeleton className="h-4 w-32" />
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5 px-2 py-3">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-full max-w-xl" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function Bots() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Bots" }]);
  }, [setBreadcrumbs]);
  const botsQuery = useQuery({
    queryKey: queryKeys.bots.list(selectedCompanyId),
    queryFn: () => botsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const botsView = useQueryView(botsQuery);
  const registrationQuery = useQuery({
    queryKey: queryKeys.bots.registration(selectedCompanyId),
    queryFn: () => botsApi.registration(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });

  const bots = botsView.data?.bots ?? [];
  const suggestedAgents = botsView.data?.suggestedAgents ?? [];
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return bots;
    return bots.filter((bot) =>
      [bot.name, bot.purpose ?? "", bot.note ?? "", bot.gateway?.keyId ?? "", bot.gateway?.policy ?? "", bot.status]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [bots, needle]);

  if (!selectedCompanyId) {
    return (
      <div className="p-4">
        <EmptyState icon={Bot} title="Select a company" message="Choose a company to see the bots it runs." />
      </div>
    );
  }

  if (botsView.kind === "loading" || botsView.kind === "reconnecting") {
    return <BotsLoadingSkeleton />;
  }

  if (botsView.kind === "error") {
    return (
      <div className="p-4">
        <QueryErrorState
          size="panel"
          error={botsView.error}
          action="load the bots"
          onRetry={botsView.retry}
          retrying={botsView.isFetching}
        />
      </div>
    );
  }

  const registered = filtered.filter((bot) => bot.registered);
  const unregistered = filtered.filter((bot) => !bot.registered);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Bot aria-hidden className="size-6" />
            Bots
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every bot this company runs, with the gateway key and policy it uses, its routines, its status and its recent
            activity. Gateway key ids are identifiers; secret values never appear here.
          </p>
        </div>
        <div className="w-full sm:w-80 sm:shrink-0">
          <ToolbarSearch
            query={query}
            onQueryChange={setQuery}
            label="Search bots"
            placeholder="Search bots, keys or policies"
          />
        </div>
      </div>

      <p className="sr-only" role="status">
        {needle ? `${filtered.length} of ${bots.length} bots match “${query.trim()}”.` : `${bots.length} bots.`}
      </p>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-2">
            {bots.length === 0 ? (
              <EmptyState
                icon={Bot}
                title="No bots yet"
                message="This company has no bots yet. Tag an agent as a bot (grokBotTwin or agentKind bot) to give it a page with its key, routines and activity."
                action="Open agents"
                onAction={() => navigate("/agents/all")}
                hideActionIcon
              />
            ) : (
              <EmptyState
                icon={SearchX}
                title="No bots match"
                message={`No bot matches “${query.trim()}”. Try a name, gateway key id or policy.`}
                action="Show all bots"
                onAction={() => setQuery("")}
                hideActionIcon
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <h2 className="text-sm leading-none font-semibold">Roster</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-6 pt-0">
            <BotSection title="Registered bots" bots={registered} />
            <BotSection title="Not registered yet" bots={unregistered} />
            <SuggestedAgentSection agents={suggestedAgents} />
            <RegistrationPlanSection plan={registrationQuery.data} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default Bots;
