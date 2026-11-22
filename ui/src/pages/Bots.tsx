import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, RefreshCw, SearchX } from "lucide-react";
import type { CompanyBotSummary, SuggestedAgentBot } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
              to={`/agents/${agent.agentId}`}
              className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="text-sm font-medium text-foreground">{agent.name}</span>
              <Badge variant="outline">{agent.adapterType}</Badge>
              <span className="text-xs text-muted-foreground">{agent.status}</span>
              <span className="ml-auto text-xs text-muted-foreground">Open agent</span>
            </Link>
          </li>
        ))}
      </ul>
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
    return (
      <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <RefreshCw aria-hidden className="size-4 animate-spin" />
        Loading bots…
      </div>
    );
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default Bots;
