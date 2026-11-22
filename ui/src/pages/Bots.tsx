import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, RefreshCw } from "lucide-react";
import type { CompanyBotSummary, SuggestedAgentBot } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { botsApi } from "@/api/bots";

function GatewayLine({ bot }: { bot: CompanyBotSummary }) {
  if (bot.gateway) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono text-foreground">{bot.gateway.keyId}</span>
        <Badge variant="outline">{bot.gateway.policy}</Badge>
        {bot.gateway.provider ? <span>{bot.gateway.provider}</span> : null}
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      {bot.registered ? "Gateway key not linked." : "No agent or gateway key yet."}
    </span>
  );
}

function BotRow({ bot }: { bot: CompanyBotSummary }) {
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        to={`/bots/${bot.id}`}
        className="flex flex-col gap-1 py-3 hover:bg-muted/40 focus-visible:bg-muted/40"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Bot aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">{bot.name}</span>
          {bot.grokBotTwin ? <Badge variant="outline">Grok twin</Badge> : null}
          <Badge variant="outline">{bot.kind === "gateway" ? "Gateway bot" : "Agent bot"}</Badge>
          <span className="text-xs text-muted-foreground">{bot.status}</span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {bot.purpose ?? (bot.registered ? "No purpose recorded yet." : bot.note)}
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
      <h2 className="mb-2 text-sm font-semibold text-foreground">
        Agents that look like bots <span className="font-normal text-muted-foreground">({agents.length})</span>
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        These agents run on the Hermes gateway but are not tagged as bots yet. Add{" "}
        <code className="font-mono">grokBotTwin</code> or <code className="font-mono">agentKind: &quot;bot&quot;</code> to
        their metadata to move them into Bots.
      </p>
      <ul>
        {agents.map((agent) => (
          <li key={agent.agentId} className="border-b border-border last:border-b-0">
            <Link to={`/agents/${agent.agentId}`} className="flex flex-wrap items-center gap-2 py-2 hover:bg-muted/40">
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
      <h2 className="mb-2 text-sm font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">({bots.length})</span>
      </h2>
      <ul>{bots.map((bot) => <BotRow key={bot.id} bot={bot} />)}</ul>
    </section>
  );
}

export function Bots() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
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
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return bots;
    return bots.filter((bot) =>
      [bot.name, bot.purpose ?? "", bot.gateway?.keyId ?? "", bot.gateway?.policy ?? "", bot.status]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [bots, query]);

  if (!selectedCompanyId) {
    return (
      <div className="p-4">
        <EmptyState icon={Bot} title="Select a company" message="Choose a company to see the bots it runs." />
      </div>
    );
  }

  if (botsView.kind === "loading" || botsView.kind === "reconnecting") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
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
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Bot aria-hidden className="size-6" />
            Bots
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every bot this company runs, with the gateway key and policy it uses, its routines, its status and its recent
            activity. Gateway key ids are identifiers; secret values never appear here.
          </p>
        </div>
        <div className="w-full max-w-sm">
          <ToolbarSearch
            query={query}
            onQueryChange={setQuery}
            label="Search bots"
            placeholder="Search bots, keys or policies"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-2">
            <p className="py-6 text-center text-sm text-muted-foreground">
              {bots.length === 0 ? "This company has no bots yet." : "No bot matches this search."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Roster</CardTitle>
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
