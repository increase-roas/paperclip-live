import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  irOpsApi,
  type AccountingStatus,
  type Ga4Choice,
  type GhlLocationChoice,
  type GhlResourceChoices,
  type MetaChoice,
  type SourceKey,
  type TenantDiagnostic,
  type TenantProfile,
  type TenantStoredHealth,
} from "../api/irOps";
import {
  buildDiagnosticDraftProfile,
  buildTenantRequestBody,
  currentUtcMonth,
  diagnosticReasonLabel,
  formatClientReportUrl,
  getTenantConnectionBadges,
  SOURCE_LABELS,
  statusBadgeTone,
  summarizeStoredHealth,
  withTenantDefaults,
  type ConnectionBadgeState,
} from "./clients/clientHelpers";

function ConnectionPill({ label, state }: { label: string; state: ConnectionBadgeState }) {
  if (state === "not_applicable") {
    return (
      <Badge variant="outline" className="border-border bg-muted/60 text-muted-foreground font-normal">
        {label}: N/A
      </Badge>
    );
  }
  if (state === "connected") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-normal"
      >
        {label}: Connected
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-amber-500/30 bg-amber-500/10 text-amber-300 font-normal"
    >
      {label}: Missing
    </Badge>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = statusBadgeTone(status);
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-normal",
        tone === "ok" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        tone === "warn" && "border-amber-500/30 bg-amber-500/10 text-amber-300",
        tone === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
        tone === "muted" && "border-border bg-muted/60 text-muted-foreground",
      )}
    >
      {status}
    </Badge>
  );
}

const EMPTY_NEW_CLIENT: TenantProfile = {
  version: 1,
  slug: "",
  displayName: "",
  ghlLocationId: "",
  businessType: "hot_tub",
  capacityMode: "install",
  financialTracking: "ghl",
};

export function ClientsPage() {
  const { setBreadcrumbs } = useBreadcrumbs();

  const [tenants, setTenants] = useState<TenantProfile[]>([]);
  const [healthBySlug, setHealthBySlug] = useState<Record<string, TenantStoredHealth>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "needs_action" | "healthy">("all");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "diagnostics" | "links">("overview");

  const [draft, setDraft] = useState<TenantProfile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingSlug, setSyncingSlug] = useState<string | null>(null);
  const [runningDiag, setRunningDiag] = useState(false);
  const [liveDiagBySlug, setLiveDiagBySlug] = useState<Record<string, TenantDiagnostic>>({});

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Provider discovery state
  const [discovering, setDiscovering] = useState(false);
  const [ghlLocations, setGhlLocations] = useState<GhlLocationChoice[]>([]);
  const [ghlResources, setGhlResources] = useState<GhlResourceChoices>({ calendars: [], pipelines: [] });
  const [metaChoices, setMetaChoices] = useState<MetaChoice[]>([]);
  const [ga4Choices, setGa4Choices] = useState<Ga4Choice[]>([]);
  const [discoveryNote, setDiscoveryNote] = useState<string | null>(null);

  // Links & Accounting state
  const [menuLink, setMenuLink] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [accounting, setAccounting] = useState<AccountingStatus | null>(null);
  const [accountingLoading, setAccountingLoading] = useState(false);
  const [accountingBusy, setAccountingBusy] = useState(false);

  // Add client dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [newClient, setNewClient] = useState<TenantProfile>(EMPTY_NEW_CLIENT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Clients" }]);
  }, [setBreadcrumbs]);

  const loadAll = useCallback(async (preferredSlug?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [tenantsRes, healthRes] = await Promise.allSettled([
        irOpsApi.salesDashboard.getTenants(),
        irOpsApi.salesDashboard.getDiagnosticHealth(),
      ]);

      if (tenantsRes.status === "rejected") {
        throw tenantsRes.reason;
      }

      const list = Array.isArray(tenantsRes.value.tenants) ? tenantsRes.value.tenants : [];
      setTenants(list);

      if (healthRes.status === "fulfilled" && Array.isArray(healthRes.value.tenants)) {
        const mapped: Record<string, TenantStoredHealth> = {};
        for (const item of healthRes.value.tenants) {
          mapped[item.slug] = item;
        }
        setHealthBySlug(mapped);
      }

      setSelectedSlug((current) => {
        const target = preferredSlug ?? current;
        if (target && list.some((t) => t.slug === target)) return target;
        return list[0]?.slug ?? null;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load client workspaces.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const selectedTenant = useMemo(
    () => tenants.find((t) => t.slug === selectedSlug) ?? null,
    [tenants, selectedSlug],
  );

  const loadAccounting = useCallback(async (slug: string) => {
    setAccountingLoading(true);
    setAccounting(null);
    try {
      const res = await irOpsApi.salesDashboard.getAccounting(slug);
      setAccounting(res.ok && res.status ? res.status : null);
    } catch {
      setAccounting(null);
    } finally {
      setAccountingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedTenant) {
      setDraft(null);
      setDirty(false);
      setMenuLink("");
      setAccounting(null);
      return;
    }
    setDraft(withTenantDefaults(selectedTenant));
    setDirty(false);
    setMenuLink("");
    setNotice(null);
    setActionError(null);
    void loadAccounting(selectedTenant.slug);
  }, [selectedTenant, loadAccounting]);

  const filteredTenants = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tenants.filter((t) => {
      if (q && !t.displayName.toLowerCase().includes(q) && !t.slug.toLowerCase().includes(q)) {
        return false;
      }
      if (filterMode === "all") return true;
      const summary = summarizeStoredHealth(healthBySlug[t.slug]);
      if (filterMode === "needs_action") return summary.status === "needs_action" || summary.status === "stale";
      return summary.status === "healthy";
    });
  }, [tenants, search, filterMode, healthBySlug]);

  const needsActionCount = useMemo(
    () =>
      tenants.filter((t) => {
        const s = summarizeStoredHealth(healthBySlug[t.slug]);
        return s.status === "needs_action" || s.status === "stale";
      }).length,
    [tenants, healthBySlug],
  );

  const editDraft = <K extends keyof TenantProfile>(key: K, value: TenantProfile[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    setDirty(true);
    setNotice(null);
    setActionError(null);
  };

  const discoverProvider = async (provider: "ghl" | "meta" | "ga4") => {
    setDiscovering(true);
    setActionError(null);
    setDiscoveryNote(null);
    try {
      if (provider === "ghl") {
        const collected: GhlLocationChoice[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const res = await irOpsApi.salesDashboard.discoverGhlLocations(offset, 25);
          if (Array.isArray(res.locations)) collected.push(...res.locations);
          offset = typeof res.nextOffset === "number" ? res.nextOffset : null;
        }
        setGhlLocations(collected);
        const locId = (draft?.ghlLocationId ?? newClient.ghlLocationId ?? "").trim();
        if (locId) {
          const resources = await irOpsApi.salesDashboard.discoverGhlResources(locId);
          setGhlResources({
            calendars: resources.calendars ?? [],
            pipelines: resources.pipelines ?? [],
          });
        }
        setDiscoveryNote(`Loaded ${collected.length} GHL location${collected.length === 1 ? "" : "s"}.`);
      } else if (provider === "meta") {
        const res = await irOpsApi.salesDashboard.discoverMetaAccounts();
        const accounts = res.accounts ?? [];
        setMetaChoices(accounts);
        setDiscoveryNote(`Loaded ${accounts.length} Meta ad account${accounts.length === 1 ? "" : "s"}.`);
      } else {
        const res = await irOpsApi.salesDashboard.discoverGa4Properties();
        const props = res.properties ?? [];
        setGa4Choices(props);
        setDiscoveryNote(`Loaded ${props.length} GA4 propert${props.length === 1 ? "y" : "ies"}.`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Could not discover ${provider.toUpperCase()} accounts.`);
    } finally {
      setDiscovering(false);
    }
  };

  const discoverLocationResources = async (locationId: string) => {
    const trimmed = locationId.trim();
    if (!trimmed) return;
    setDiscovering(true);
    try {
      const res = await irOpsApi.salesDashboard.discoverGhlResources(trimmed);
      setGhlResources({
        calendars: res.calendars ?? [],
        pipelines: res.pipelines ?? [],
      });
      setDiscoveryNote("Loaded calendars and pipelines for this GHL location.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not load GHL calendars and pipelines.");
    } finally {
      setDiscovering(false);
    }
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await irOpsApi.salesDashboard.updateTenant(buildTenantRequestBody(draft));
      const updatedSlug = res.tenant?.slug ?? draft.slug;
      if (res.customMenuUrl) setMenuLink(res.customMenuUrl);
      setNotice("Client settings saved. Snapshot sync started.");
      setDirty(false);
      await loadAll(updatedSlug);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not save client settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleSyncClient = async (slug: string) => {
    setSyncingSlug(slug);
    setActionError(null);
    setNotice(`Syncing ${slug}…`);
    try {
      await irOpsApi.salesDashboard.triggerSync({ slug });
      setNotice(`Synced ${slug} cleanly.`);
      await loadAll(slug);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Sync failed for ${slug}.`);
    } finally {
      setSyncingSlug(null);
    }
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    setActionError(null);
    setNotice("Syncing all client dashboards…");
    try {
      await irOpsApi.salesDashboard.triggerSync({ all: true });
      setNotice("All clients synced.");
      await loadAll(selectedSlug ?? undefined);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Sync all failed.");
    } finally {
      setSyncingAll(false);
    }
  };

  const handleRunDiagnostics = async () => {
    if (!draft) return;
    setRunningDiag(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await irOpsApi.salesDashboard.testDraftDiagnostic(buildDiagnosticDraftProfile(draft));
      if (res.tenant) {
        setLiveDiagBySlug((prev) => ({ ...prev, [draft.slug]: res.tenant }));
        setNotice("Live connection diagnostic finished.");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Connection diagnostic failed.");
    } finally {
      setRunningDiag(false);
    }
  };

  const handleGenerateLink = async (revokeExisting: boolean) => {
    if (!selectedTenant) return;
    setLinkBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await irOpsApi.salesDashboard.generateMenuLink(selectedTenant.slug, revokeExisting);
      if (res.customMenuUrl) {
        setMenuLink(res.customMenuUrl);
        setNotice(
          revokeExisting
            ? "Replacement GHL Custom Menu Link created. Previous links were revoked."
            : "GHL Custom Menu Link created. Existing links remain active.",
        );
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not generate menu link.");
    } finally {
      setLinkBusy(false);
      setRevokeDialogOpen(false);
    }
  };

  const handleCopyMenuLink = async () => {
    if (!menuLink) return;
    try {
      await navigator.clipboard.writeText(menuLink);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      setActionError("Copy failed — select the URL and copy manually.");
    }
  };

  const handleConnectQuickBooks = async () => {
    if (!selectedTenant) return;
    setAccountingBusy(true);
    setActionError(null);
    try {
      const res = await irOpsApi.salesDashboard.connectAccounting(selectedTenant.slug);
      if (res.authorizeUrl) {
        window.open(res.authorizeUrl, "_blank", "noopener,noreferrer");
      } else {
        setActionError("QuickBooks authorization URL was not returned.");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not connect QuickBooks.");
    } finally {
      setAccountingBusy(false);
    }
  };

  const handleDisconnectQuickBooks = async () => {
    if (!selectedTenant) return;
    setAccountingBusy(true);
    setActionError(null);
    try {
      await irOpsApi.salesDashboard.disconnectAccounting(selectedTenant.slug);
      setNotice("QuickBooks disconnected for this client.");
      await loadAccounting(selectedTenant.slug);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not disconnect QuickBooks.");
    } finally {
      setAccountingBusy(false);
    }
  };

  const handleCreateClient = async (event: FormEvent) => {
    event.preventDefault();
    if (!newClient.displayName.trim() || !newClient.ghlLocationId.trim()) {
      setCreateError("Display name and GHL location ID are required.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await irOpsApi.salesDashboard.createTenant(buildTenantRequestBody(newClient));
      const slug = res.slug ?? res.tenant?.slug;
      setAddOpen(false);
      setNewClient(EMPTY_NEW_CLIENT);
      if (res.customMenuUrl) setMenuLink(res.customMenuUrl);
      setNotice(`Added client ${newClient.displayName.trim()}.`);
      await loadAll(slug);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create client.");
    } finally {
      setCreating(false);
    }
  };

  const stageChoices = useMemo(() => {
    if (!draft?.ghlPipelineName) return ghlResources.pipelines.flatMap((p) => p.stages);
    return (
      ghlResources.pipelines.find((p) => p.name === draft.ghlPipelineName)?.stages ??
      ghlResources.pipelines.flatMap((p) => p.stages)
    );
  }, [draft?.ghlPipelineName, ghlResources.pipelines]);

  const selectedStoredHealth = selectedTenant ? healthBySlug[selectedTenant.slug] : undefined;
  const selectedHealthSummary = summarizeStoredHealth(selectedStoredHealth);
  const selectedLiveDiag = selectedTenant ? liveDiagBySlug[selectedTenant.slug] : undefined;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Clients</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage client dashboard connections, run live diagnostics, and issue customer report links.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || syncingAll}
            onClick={() => void handleSyncAll()}
          >
            <RefreshCw className={cn("size-3.5", syncingAll && "animate-spin")} />
            {syncingAll ? "Syncing…" : "Sync All"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setCreateError(null);
              setNewClient(EMPTY_NEW_CLIENT);
              setAddOpen(true);
            }}
          >
            <Plus className="size-3.5" />
            Add client
          </Button>
        </div>
      </header>

      {loadError && (
        <Card className="border-destructive/40 bg-destructive/5 py-4">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 px-4">
            <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
              <AlertTriangle className="size-4 shrink-0" />
              <span>{loadError}</span>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadAll()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left Master List */}
        <Card className="gap-0 py-0 lg:col-span-4">
          <CardHeader className="gap-3 border-b border-border px-4 py-3.5">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-semibold">
                Connected Clients ({tenants.length})
              </CardTitle>
              {needsActionCount > 0 && (
                <Badge
                  variant="outline"
                  className="border-amber-500/30 bg-amber-500/10 text-amber-300 font-normal"
                >
                  {needsActionCount} needs action
                </Badge>
              )}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search clients…"
                className="h-8 pl-8 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              {(
                [
                  ["all", "All"],
                  ["needs_action", "Needs action"],
                  ["healthy", "Healthy"],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  size="xs"
                  variant={filterMode === key ? "secondary" : "ghost"}
                  onClick={() => setFilterMode(key)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </CardHeader>

          <CardContent className="max-h-160 divide-y divide-border overflow-y-auto px-0">
            {loading ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : filteredTenants.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {tenants.length === 0 ? "No clients configured yet." : "No clients match your filter."}
              </div>
            ) : (
              filteredTenants.map((tenant) => {
                const badges = getTenantConnectionBadges(tenant);
                const health = summarizeStoredHealth(healthBySlug[tenant.slug]);
                const active = tenant.slug === selectedSlug;
                return (
                  <button
                    key={tenant.slug}
                    type="button"
                    onClick={() => setSelectedSlug(tenant.slug)}
                    className={cn(
                      "flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors",
                      active ? "bg-accent/70" : "hover:bg-accent/35",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                          {tenant.displayName}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">{tenant.slug}</div>
                      </div>
                      {health.status === "healthy" && (
                        <Badge
                          variant="outline"
                          className="shrink-0 border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-normal"
                        >
                          Healthy
                        </Badge>
                      )}
                      {health.status === "needs_action" && (
                        <Badge
                          variant="outline"
                          className="shrink-0 border-destructive/40 bg-destructive/10 text-destructive font-normal"
                        >
                          Needs action
                        </Badge>
                      )}
                      {health.status === "stale" && (
                        <Badge
                          variant="outline"
                          className="shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-300 font-normal"
                        >
                          Stale
                        </Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <ConnectionPill label="GHL" state={badges.ghl} />
                      <ConnectionPill label="Meta" state={badges.meta} />
                      <ConnectionPill label="GA4" state={badges.ga4} />
                    </div>

                    {health.issues.length > 0 && (
                      <div className="flex flex-col gap-0.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
                        {health.issues.map((issue) => (
                          <div key={issue.source} className="truncate">
                            <span className="font-medium">{issue.label}:</span>{" "}
                            {diagnosticReasonLabel(issue.reason) || "Needs action"}
                          </div>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Right Detail Workspace */}
        <Card className="gap-0 py-0 lg:col-span-8">
          {!selectedTenant || !draft ? (
            <CardContent className="flex min-h-80 flex-col items-center justify-center gap-2 p-8 text-center">
              <Building2 className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">Select a client workspace</p>
              <p className="text-xs text-muted-foreground">
                Pick a client on the left to inspect health, edit provider IDs, or generate a GHL menu link.
              </p>
            </CardContent>
          ) : (
            <>
              <CardHeader className="gap-3 border-b border-border px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base font-semibold text-foreground">
                        {selectedTenant.displayName}
                      </CardTitle>
                      <Badge variant="secondary" className="font-mono text-xs font-normal">
                        /c/{selectedTenant.slug}
                      </Badge>
                      {selectedHealthSummary.status === "healthy" && (
                        <StatusPill status="HEALTHY" />
                      )}
                      {selectedHealthSummary.status === "needs_action" && (
                        <StatusPill status="NEEDS ACTION" />
                      )}
                      {selectedHealthSummary.status === "stale" && (
                        <StatusPill status="STALE" />
                      )}
                    </div>
                    <CardDescription className="mt-1 text-xs">
                      {selectedHealthSummary.lastSyncAt
                        ? `Last synced ${new Date(selectedHealthSummary.lastSyncAt).toLocaleString()}`
                        : "No recent snapshot sync recorded yet."}
                    </CardDescription>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={syncingSlug === selectedTenant.slug}
                      onClick={() => void handleSyncClient(selectedTenant.slug)}
                    >
                      <RefreshCw
                        className={cn("size-3.5", syncingSlug === selectedTenant.slug && "animate-spin")}
                      />
                      {syncingSlug === selectedTenant.slug ? "Syncing…" : "Sync Now"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={runningDiag}
                      onClick={() => {
                        setActiveTab("diagnostics");
                        void handleRunDiagnostics();
                      }}
                    >
                      <Stethoscope className="size-3.5" />
                      {runningDiag ? "Testing…" : "Run Diagnostics"}
                    </Button>
                    <Button type="button" variant="outline" size="sm" asChild>
                      <a
                        href={formatClientReportUrl(selectedTenant.slug)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open client report
                        <ExternalLink className="size-3.5" />
                      </a>
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="p-5">
                {notice && (
                  <div
                    role="status"
                    className="mb-4 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300"
                  >
                    <CheckCircle2 className="size-4 shrink-0" />
                    <span>{notice}</span>
                  </div>
                )}
                {actionError && (
                  <div
                    role="alert"
                    className="mb-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  >
                    <AlertTriangle className="size-4 shrink-0" />
                    <span>{actionError}</span>
                  </div>
                )}

                <Tabs
                  value={activeTab}
                  onValueChange={(v) => setActiveTab(v as "overview" | "diagnostics" | "links")}
                >
                  <TabsList className="mb-4 rounded-md">
                    <TabsTrigger value="overview" className="rounded-sm px-3 text-xs">
                      Overview & Connections
                    </TabsTrigger>
                    <TabsTrigger value="diagnostics" className="rounded-sm px-3 text-xs">
                      Diagnostics
                      {selectedHealthSummary.issues.length > 0 && (
                        <Badge
                          variant="destructive"
                          className="ml-1 px-1.5 py-0 text-xs leading-tight"
                        >
                          {selectedHealthSummary.issues.length}
                        </Badge>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="links" className="rounded-sm px-3 text-xs">
                      Customer Link & Financials
                    </TabsTrigger>
                  </TabsList>

                  {/* Tab 1: Overview & Connections */}
                  <TabsContent value="overview" className="space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3.5 py-2.5">
                      <div className="text-xs text-muted-foreground">
                        {discoveryNote ?? "Pull live locations, calendars, Meta accounts, or GA4 properties from connected agency accounts."}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={discovering}
                          onClick={() => void discoverProvider("ghl")}
                        >
                          <Sparkles className="size-3" />
                          Discover GHL
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={discovering}
                          onClick={() => void discoverProvider("meta")}
                        >
                          <Sparkles className="size-3" />
                          Discover Meta
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={discovering}
                          onClick={() => void discoverProvider("ga4")}
                        >
                          <Sparkles className="size-3" />
                          Discover GA4
                        </Button>
                      </div>
                    </div>

                    <form onSubmit={handleSave} className="space-y-5">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="client-display-name" className="text-xs">
                            Display name
                          </Label>
                          <Input
                            id="client-display-name"
                            value={draft.displayName}
                            onChange={(e) => editDraft("displayName", e.target.value)}
                            required
                          />
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="client-business-type" className="text-xs">
                            Business type
                          </Label>
                          <Select
                            value={draft.businessType ?? "hot_tub"}
                            onValueChange={(value) => {
                              const bt = value as NonNullable<TenantProfile["businessType"]>;
                              const cap =
                                bt === "hot_tub" ? "install" : bt === "tree_service" ? "estimate" : "not_applicable";
                              setDraft((prev) => (prev ? { ...prev, businessType: bt, capacityMode: cap } : prev));
                              setDirty(true);
                            }}
                          >
                            <SelectTrigger id="client-business-type" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="hot_tub">Hot tub dealer</SelectItem>
                              <SelectItem value="tree_service">Tree service</SelectItem>
                              <SelectItem value="other">Other</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="client-cash-target" className="text-xs">
                            Monthly cash target (USD)
                          </Label>
                          <Input
                            id="client-cash-target"
                            type="number"
                            min={1}
                            step={1}
                            value={draft.monthlyCashTarget ?? ""}
                            onChange={(e) =>
                              editDraft(
                                "monthlyCashTarget",
                                e.target.value === "" ? undefined : Number(e.target.value),
                              )
                            }
                            placeholder="e.g. 150000"
                          />
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="client-capacity-mode" className="text-xs">
                            Capacity tracking
                          </Label>
                          <Select
                            value={draft.capacityMode ?? "install"}
                            onValueChange={(v) =>
                              editDraft("capacityMode", v as NonNullable<TenantProfile["capacityMode"]>)
                            }
                          >
                            <SelectTrigger id="client-capacity-mode" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="install">Install slots</SelectItem>
                              <SelectItem value="estimate">Estimate slots</SelectItem>
                              <SelectItem value="not_applicable">Not applicable</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <Separator />

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            GoHighLevel
                          </h3>
                          {draft.ghlLocationId && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={discovering}
                              onClick={() => void discoverLocationResources(draft.ghlLocationId)}
                            >
                              Load calendars & pipelines
                            </Button>
                          )}
                        </div>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="client-ghl-loc" className="text-xs">
                              GHL Location ID
                            </Label>
                            <Input
                              id="client-ghl-loc"
                              className="font-mono text-xs"
                              value={draft.ghlLocationId}
                              onChange={(e) => editDraft("ghlLocationId", e.target.value)}
                              required
                            />
                            {ghlLocations.length > 0 && (
                              <Select
                                value={draft.ghlLocationId}
                                onValueChange={(v) => {
                                  editDraft("ghlLocationId", v);
                                  void discoverLocationResources(v);
                                }}
                              >
                                <SelectTrigger className="h-8 w-full text-xs">
                                  <SelectValue placeholder="Pick discovered GHL location" />
                                </SelectTrigger>
                                <SelectContent>
                                  {ghlLocations.map((loc) => (
                                    <SelectItem key={loc.id} value={loc.id}>
                                      {loc.name} ({loc.id})
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>

                          <div className="space-y-1.5">
                            <Label htmlFor="client-ghl-cal" className="text-xs">
                              Appointment calendar ID
                            </Label>
                            <Input
                              id="client-ghl-cal"
                              className="font-mono text-xs"
                              value={draft.ghlCalendarId ?? ""}
                              onChange={(e) => editDraft("ghlCalendarId", e.target.value)}
                            />
                            {ghlResources.calendars.length > 0 && (
                              <Select
                                value={draft.ghlCalendarId || ""}
                                onValueChange={(v) => editDraft("ghlCalendarId", v)}
                              >
                                <SelectTrigger className="h-8 w-full text-xs">
                                  <SelectValue placeholder="Pick discovered calendar" />
                                </SelectTrigger>
                                <SelectContent>
                                  {ghlResources.calendars.map((c) => (
                                    <SelectItem key={c.id} value={c.id}>
                                      {c.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>

                          {draft.capacityMode !== "not_applicable" && (
                            <div className="space-y-1.5">
                              <Label htmlFor="client-ghl-install-cal" className="text-xs">
                                {draft.capacityMode === "estimate"
                                  ? "Estimate calendar ID"
                                  : "Install calendar ID"}
                              </Label>
                              <Input
                                id="client-ghl-install-cal"
                                className="font-mono text-xs"
                                value={draft.ghlInstallCalendarId ?? ""}
                                onChange={(e) => editDraft("ghlInstallCalendarId", e.target.value)}
                              />
                              {ghlResources.calendars.length > 0 && (
                                <Select
                                  value={draft.ghlInstallCalendarId || ""}
                                  onValueChange={(v) => editDraft("ghlInstallCalendarId", v)}
                                >
                                  <SelectTrigger className="h-8 w-full text-xs">
                                    <SelectValue placeholder="Pick capacity calendar" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {ghlResources.calendars.map((c) => (
                                      <SelectItem key={c.id} value={c.id}>
                                        {c.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            </div>
                          )}

                          <div className="space-y-1.5">
                            <Label htmlFor="client-ghl-pipeline" className="text-xs">
                              Pipeline name
                            </Label>
                            <Input
                              id="client-ghl-pipeline"
                              value={draft.ghlPipelineName ?? ""}
                              onChange={(e) => editDraft("ghlPipelineName", e.target.value)}
                            />
                            {ghlResources.pipelines.length > 0 && (
                              <Select
                                value={draft.ghlPipelineName || ""}
                                onValueChange={(v) => editDraft("ghlPipelineName", v)}
                              >
                                <SelectTrigger className="h-8 w-full text-xs">
                                  <SelectValue placeholder="Pick discovered pipeline" />
                                </SelectTrigger>
                                <SelectContent>
                                  {ghlResources.pipelines.map((p) => (
                                    <SelectItem key={p.id} value={p.name}>
                                      {p.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>

                          <div className="space-y-1.5">
                            <Label htmlFor="client-ghl-stage" className="text-xs">
                              Proposal / pitch stage name
                            </Label>
                            <Input
                              id="client-ghl-stage"
                              value={draft.ghlProposalStageName ?? ""}
                              onChange={(e) => editDraft("ghlProposalStageName", e.target.value)}
                            />
                            {stageChoices.length > 0 && (
                              <Select
                                value={draft.ghlProposalStageName || ""}
                                onValueChange={(v) => editDraft("ghlProposalStageName", v)}
                              >
                                <SelectTrigger className="h-8 w-full text-xs">
                                  <SelectValue placeholder="Pick pipeline stage" />
                                </SelectTrigger>
                                <SelectContent>
                                  {stageChoices.map((s) => (
                                    <SelectItem key={s.id} value={s.name}>
                                      {s.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        </div>
                      </div>

                      <Separator />

                      <div className="space-y-3">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Meta Ads & Website Analytics (GA4)
                        </h3>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="client-meta-tracking" className="text-xs">
                              Meta Ads tracking
                            </Label>
                            <Select
                              value={draft.metaTracking ?? "tracked"}
                              onValueChange={(v) => {
                                const na = v === "not_applicable";
                                setDraft((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        metaTracking: na ? "not_applicable" : undefined,
                                        metaAdAccountId: na ? undefined : prev.metaAdAccountId,
                                      }
                                    : prev,
                                );
                                setDirty(true);
                              }}
                            >
                              <SelectTrigger id="client-meta-tracking" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="tracked">Track Meta Ads</SelectItem>
                                <SelectItem value="not_applicable">Not applicable — no Meta Ads</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-1.5">
                            <Label htmlFor="client-meta-id" className="text-xs">
                              Meta Ad Account ID
                            </Label>
                            <Input
                              id="client-meta-id"
                              className="font-mono text-xs"
                              disabled={draft.metaTracking === "not_applicable"}
                              placeholder="act_4013508225402510"
                              value={draft.metaAdAccountId ?? ""}
                              onChange={(e) => editDraft("metaAdAccountId", e.target.value)}
                            />
                            {metaChoices.length > 0 && draft.metaTracking !== "not_applicable" && (
                              <Select
                                value={draft.metaAdAccountId || ""}
                                onValueChange={(v) => editDraft("metaAdAccountId", v)}
                              >
                                <SelectTrigger className="h-8 w-full text-xs">
                                  <SelectValue placeholder="Pick discovered Meta account" />
                                </SelectTrigger>
                                <SelectContent>
                                  {metaChoices
                                    .filter((m) => m.selectable)
                                    .map((m) => (
                                      <SelectItem key={m.id} value={m.id}>
                                        {m.name} · {m.currency}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>

                          <div className="space-y-1.5">
                            <Label htmlFor="client-ga4-tracking" className="text-xs">
                              Website tracking (GA4)
                            </Label>
                            <Select
                              value={draft.websiteTracking ?? "tracked"}
                              onValueChange={(v) => {
                                const na = v === "not_applicable";
                                setDraft((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        websiteTracking: na ? "not_applicable" : undefined,
                                        ga4PropertyId: na ? undefined : prev.ga4PropertyId,
                                      }
                                    : prev,
                                );
                                setDirty(true);
                              }}
                            >
                              <SelectTrigger id="client-ga4-tracking" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="tracked">Track with GA4</SelectItem>
                                <SelectItem value="not_applicable">
                                  Not applicable — no tracked website
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-1.5">
                            <Label htmlFor="client-ga4-id" className="text-xs">
                              GA4 Property ID
                            </Label>
                            <Input
                              id="client-ga4-id"
                              className="font-mono text-xs"
                              disabled={draft.websiteTracking === "not_applicable"}
                              placeholder="Digits only"
                              value={draft.ga4PropertyId ?? ""}
                              onChange={(e) => editDraft("ga4PropertyId", e.target.value)}
                            />
                            {ga4Choices.length > 0 && draft.websiteTracking !== "not_applicable" && (
                              <Select
                                value={draft.ga4PropertyId || ""}
                                onValueChange={(v) => editDraft("ga4PropertyId", v)}
                              >
                                <SelectTrigger className="h-8 w-full text-xs">
                                  <SelectValue placeholder="Pick discovered GA4 property" />
                                </SelectTrigger>
                                <SelectContent>
                                  {ga4Choices.map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                      {p.name} · {p.accountName}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Shared footer row per DESIGN.md: secondary on left, primary on right */}
                      <div className="flex items-center justify-between border-t border-border pt-4">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!dirty || saving}
                          onClick={() => {
                            setDraft(withTenantDefaults(selectedTenant));
                            setDirty(false);
                          }}
                        >
                          Discard changes
                        </Button>
                        <Button type="submit" size="sm" disabled={!dirty || saving}>
                          {saving ? "Saving…" : "Save changes"}
                        </Button>
                      </div>
                    </form>
                  </TabsContent>

                  {/* Tab 2: Diagnostics */}
                  <TabsContent value="diagnostics" className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">Connection Diagnostics</h3>
                        <p className="text-xs text-muted-foreground">
                          Inspect live provider health and stored snapshot freshness across all 6 data sources.
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={runningDiag}
                        onClick={() => void handleRunDiagnostics()}
                      >
                        <Stethoscope className="size-3.5" />
                        {runningDiag ? "Running live test…" : "Run live diagnostic"}
                      </Button>
                    </div>

                    {selectedLiveDiag && (
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          Live test result · {new Date(selectedLiveDiag.lastTestedAt).toLocaleString()}
                        </div>
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                          {(Object.keys(SOURCE_LABELS) as SourceKey[]).map((key) => {
                            const status = selectedLiveDiag[key];
                            const reason = selectedLiveDiag.reasons?.[key];
                            return (
                              <div
                                key={key}
                                className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-medium text-foreground">
                                    {SOURCE_LABELS[key]}
                                  </span>
                                  <StatusPill status={status} />
                                </div>
                                {reason && (
                                  <p className="text-xs text-muted-foreground">
                                    {diagnosticReasonLabel(reason)}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {selectedStoredHealth ? (
                      <div className="space-y-3">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Stored Snapshot Health
                        </h4>
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                          {Object.entries(selectedStoredHealth.views).map(([viewName, view]) => (
                            <div
                              key={viewName}
                              className="space-y-2 rounded-lg border border-border bg-muted/20 p-3"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-xs font-semibold uppercase text-foreground">
                                  {viewName}
                                </span>
                                <StatusPill status={view.freshness} />
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {view.lastSuccessfulSyncAt
                                  ? `Synced ${new Date(view.lastSuccessfulSyncAt).toLocaleString()}`
                                  : "Never synced"}
                              </div>
                              <div className="space-y-1 pt-1">
                                {(Object.keys(SOURCE_LABELS) as SourceKey[]).map((src) => {
                                  const s = view.sources?.[src];
                                  if (!s) return null;
                                  return (
                                    <div
                                      key={src}
                                      className="flex flex-col gap-0.5 rounded-md bg-background/60 px-2 py-1 text-xs"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="text-muted-foreground">{SOURCE_LABELS[src]}</span>
                                        <StatusPill status={s.status} />
                                      </div>
                                      {s.reason && (
                                        <span className="text-xs text-destructive">
                                          {diagnosticReasonLabel(s.reason)}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No stored health snapshot returned yet. Click Run live diagnostic or Sync Now.
                      </p>
                    )}
                  </TabsContent>

                  {/* Tab 3: Customer Link & Financials */}
                  <TabsContent value="links" className="space-y-5">
                    <div className="space-y-3 rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="text-sm font-semibold text-foreground">
                            GHL Custom Menu Link
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            Generate a signed private embed URL for this client's HighLevel sub-account sidebar.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={linkBusy}
                            onClick={() => void handleGenerateLink(false)}
                          >
                            <Link2 className="size-3.5" />
                            Generate link
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={linkBusy}
                            onClick={() => setRevokeDialogOpen(true)}
                          >
                            Replace & revoke old
                          </Button>
                        </div>
                      </div>

                      {menuLink && (
                        <div className="flex items-center gap-2">
                          <Input readOnly value={menuLink} className="font-mono text-xs" />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void handleCopyMenuLink()}
                          >
                            {copiedLink ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                            {copiedLink ? "Copied" : "Copy"}
                          </Button>
                        </div>
                      )}

                      <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-xs">
                        <span className="text-muted-foreground">
                          Customer report preview:{" "}
                          <code className="font-mono text-foreground">
                            /c/{selectedTenant.slug}
                          </code>
                        </span>
                        <a
                          href={formatClientReportUrl(selectedTenant.slug)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          Open client report
                          <ExternalLink className="size-3" />
                        </a>
                      </div>
                    </div>

                    <div className="space-y-3 rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="text-sm font-semibold text-foreground">
                            Financial Tracking & QuickBooks
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            Configure how monthly sales, cash collected, and P&L totals are sourced.
                          </p>
                        </div>
                        <Select
                          value={draft.financialTracking ?? "ghl"}
                          onValueChange={(value) => {
                            const ft = value as NonNullable<TenantProfile["financialTracking"]>;
                            setDraft((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    financialTracking: ft,
                                    manualFinancials:
                                      ft === "manual"
                                        ? prev.manualFinancials ?? {
                                            month: currentUtcMonth(),
                                            totalSalesUsd: 0,
                                            cashCollectedUsd: 0,
                                            totalExpensesUsd: 0,
                                          }
                                        : undefined,
                                  }
                                : prev,
                            );
                            setDirty(true);
                          }}
                        >
                          <SelectTrigger className="w-52">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ghl">GHL payments</SelectItem>
                            <SelectItem value="manual">Manual monthly totals</SelectItem>
                            <SelectItem value="quickbooks">QuickBooks Online</SelectItem>
                            <SelectItem value="not_applicable">Not applicable</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {draft.financialTracking === "quickbooks" && (
                        <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-xs text-muted-foreground">
                              {accountingLoading
                                ? "Checking QuickBooks connection…"
                                : !accounting
                                  ? "QuickBooks status unavailable."
                                  : !accounting.configured
                                    ? "QuickBooks credentials are not configured on the dashboard server."
                                    : accounting.connected
                                      ? `Connected${accounting.connectedAt ? ` since ${new Date(accounting.connectedAt).toLocaleDateString()}` : ""}.`
                                      : "QuickBooks is not connected for this client yet."}
                            </div>
                            <div className="flex items-center gap-2">
                              {accounting?.configured && !accounting.connected && (
                                <Button
                                  type="button"
                                  size="xs"
                                  disabled={accountingBusy}
                                  onClick={() => void handleConnectQuickBooks()}
                                >
                                  Connect QuickBooks
                                </Button>
                              )}
                              {accounting?.connected && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="xs"
                                  disabled={accountingBusy}
                                  onClick={() => void handleDisconnectQuickBooks()}
                                >
                                  Disconnect
                                </Button>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                disabled={accountingLoading}
                                onClick={() => void loadAccounting(selectedTenant.slug)}
                              >
                                Refresh
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}

                      {draft.financialTracking === "manual" && draft.manualFinancials && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label className="text-xs">Month</Label>
                            <Input
                              type="month"
                              value={draft.manualFinancials.month}
                              onChange={(e) => {
                                setDraft((prev) =>
                                  prev?.manualFinancials
                                    ? {
                                        ...prev,
                                        manualFinancials: { ...prev.manualFinancials, month: e.target.value },
                                      }
                                    : prev,
                                );
                                setDirty(true);
                              }}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Total sales (USD)</Label>
                            <Input
                              type="number"
                              step="0.01"
                              value={draft.manualFinancials.totalSalesUsd}
                              onChange={(e) => {
                                setDraft((prev) =>
                                  prev?.manualFinancials
                                    ? {
                                        ...prev,
                                        manualFinancials: {
                                          ...prev.manualFinancials,
                                          totalSalesUsd: Number(e.target.value),
                                        },
                                      }
                                    : prev,
                                );
                                setDirty(true);
                              }}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Cash collected (USD)</Label>
                            <Input
                              type="number"
                              step="0.01"
                              value={draft.manualFinancials.cashCollectedUsd}
                              onChange={(e) => {
                                setDraft((prev) =>
                                  prev?.manualFinancials
                                    ? {
                                        ...prev,
                                        manualFinancials: {
                                          ...prev.manualFinancials,
                                          cashCollectedUsd: Number(e.target.value),
                                        },
                                      }
                                    : prev,
                                );
                                setDirty(true);
                              }}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Total expenses (USD)</Label>
                            <Input
                              type="number"
                              step="0.01"
                              value={draft.manualFinancials.totalExpensesUsd}
                              onChange={(e) => {
                                setDraft((prev) =>
                                  prev?.manualFinancials
                                    ? {
                                        ...prev,
                                        manualFinancials: {
                                          ...prev.manualFinancials,
                                          totalExpensesUsd: Number(e.target.value),
                                        },
                                      }
                                    : prev,
                                );
                                setDirty(true);
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {dirty && (
                        <div className="flex items-center justify-between border-t border-border pt-3">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDraft(withTenantDefaults(selectedTenant));
                              setDirty(false);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={saving}
                            onClick={(e) => void handleSave(e)}
                          >
                            {saving ? "Saving…" : "Save financial settings"}
                          </Button>
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </>
          )}
        </Card>
      </div>

      {/* Add Client Dialog — DESIGN.md footer rule: Cancel left, primary action right */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add client</DialogTitle>
            <DialogDescription>
              Connect a GoHighLevel sub-account to provision a client dashboard profile.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateClient} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-client-name" className="text-xs">
                Display name
              </Label>
              <Input
                id="new-client-name"
                value={newClient.displayName}
                onChange={(e) => setNewClient((p) => ({ ...p, displayName: e.target.value }))}
                placeholder="e.g. Paradise Spas"
                required
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="new-client-loc" className="text-xs">
                  GHL Location ID
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={discovering}
                  onClick={() => void discoverProvider("ghl")}
                >
                  <Sparkles className="size-3" />
                  Discover GHL
                </Button>
              </div>
              <Input
                id="new-client-loc"
                className="font-mono text-xs"
                value={newClient.ghlLocationId}
                onChange={(e) => setNewClient((p) => ({ ...p, ghlLocationId: e.target.value }))}
                placeholder="HighLevel sub-account ID"
                required
              />
              {ghlLocations.length > 0 && (
                <Select
                  value={newClient.ghlLocationId}
                  onValueChange={(v) => {
                    const found = ghlLocations.find((l) => l.id === v);
                    setNewClient((p) => ({
                      ...p,
                      ghlLocationId: v,
                      displayName: p.displayName || found?.name || "",
                    }));
                  }}
                >
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder="Choose from discovered GHL locations" />
                  </SelectTrigger>
                  <SelectContent>
                    {ghlLocations.map((loc) => (
                      <SelectItem key={loc.id} value={loc.id}>
                        {loc.name} ({loc.id})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-client-type" className="text-xs">
                  Business type
                </Label>
                <Select
                  value={newClient.businessType ?? "hot_tub"}
                  onValueChange={(v) => {
                    const bt = v as NonNullable<TenantProfile["businessType"]>;
                    const cap =
                      bt === "hot_tub" ? "install" : bt === "tree_service" ? "estimate" : "not_applicable";
                    setNewClient((p) => ({ ...p, businessType: bt, capacityMode: cap }));
                  }}
                >
                  <SelectTrigger id="new-client-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hot_tub">Hot tub dealer</SelectItem>
                    <SelectItem value="tree_service">Tree service</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-client-target" className="text-xs">
                  Monthly cash target (USD)
                </Label>
                <Input
                  id="new-client-target"
                  type="number"
                  min={1}
                  step={1}
                  value={newClient.monthlyCashTarget ?? ""}
                  onChange={(e) =>
                    setNewClient((p) => ({
                      ...p,
                      monthlyCashTarget: e.target.value === "" ? undefined : Number(e.target.value),
                    }))
                  }
                  placeholder="Optional"
                />
              </div>
            </div>

            {createError && (
              <p className="text-xs text-destructive" role="alert">
                {createError}
              </p>
            )}

            <DialogFooter className="flex-row items-center justify-between sm:justify-between">
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? "Adding…" : "Add client"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace GHL Custom Menu Link?</AlertDialogTitle>
            <AlertDialogDescription>
              Every previously issued custom menu link for {selectedTenant?.displayName} will stop
              working immediately and a new link will be generated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row items-center justify-between sm:justify-between">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleGenerateLink(true)}>
              Replace & revoke old links
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
