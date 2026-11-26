import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Network, RefreshCw } from "lucide-react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { IrApiError, irSystemMapApi } from "../api/irOps";
import { GbrainSkeletonTab } from "./system-map/GbrainSkeletonTab";
import { HealthChip } from "./system-map/HealthChip";
import { TopologyTab } from "./system-map/TopologyTab";
import { formatAge, healthLabel, healthTone } from "./system-map/systemMapHelpers";

type SystemMapTab = "topology" | "skeleton";

const REFRESH_MS = 60_000;

function errorMessage(error: unknown): string {
  if (error instanceof IrApiError) {
    if (error.status === 403) return "Only instance admins can open the System Map.";
    return error.message;
  }
  return error instanceof Error ? error.message : "The System Map could not load.";
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Card className="border-destructive/40 bg-destructive/5 py-5">
      <CardContent className="flex flex-wrap items-center justify-between gap-4 px-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">Live system data is unavailable</p>
            <p className="text-xs text-muted-foreground" role="alert">
              {errorMessage(error)}
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

export function SystemMapPage() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [tab, setTab] = useState<SystemMapTab>("topology");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "System Map" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const mapQuery = useQuery({
    queryKey: ["ir", "system-map"],
    queryFn: irSystemMapApi.systemMap,
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  const skeletonQuery = useQuery({
    queryKey: ["ir", "system-map", "gbrain-skeleton"],
    queryFn: irSystemMapApi.gbrainSkeleton,
    enabled: tab === "skeleton",
    refetchInterval: tab === "skeleton" ? REFRESH_MS : false,
    retry: false,
  });

  const overall = mapQuery.data?.feed.doctor.overallStatus ?? "unknown";
  const freshness = mapQuery.data?.freshness;
  const refreshing = mapQuery.isFetching || skeletonQuery.isFetching;
  const violationTotal = skeletonQuery.data
    ? Object.values(skeletonQuery.data.skeleton.violations).reduce((sum, group) => sum + group.count, 0)
    : null;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Network className="size-5 text-muted-foreground" />
            <h1 className="text-xl font-bold tracking-tight text-foreground">System Map</h1>
            {mapQuery.data ? <HealthChip tone={healthTone(overall)}>{healthLabel(overall)}</HealthChip> : null}
            {freshness ? (
              <HealthChip tone={freshness.stale ? "bad" : "muted"}>
                {freshness.stale ? `Stale · ${formatAge(freshness.ageSeconds)}` : `Updated ${formatAge(freshness.ageSeconds)}`}
              </HealthChip>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Live servers, services, health checks and the GBrain skeleton, read from brain-vps (ir-doctor, company-ops
            and GBrain).
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={refreshing}
          onClick={() => {
            void mapQuery.refetch();
            if (tab === "skeleton") void skeletonQuery.refetch();
          }}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </header>

      <Tabs value={tab} onValueChange={(value) => setTab(value as SystemMapTab)}>
        <TabsList className="mb-4 rounded-md">
          <TabsTrigger value="topology" className="rounded-sm px-3 text-xs">
            Topology
          </TabsTrigger>
          <TabsTrigger value="skeleton" className="rounded-sm px-3 text-xs">
            GBrain skeleton
            {violationTotal !== null && violationTotal > 0 ? (
              <HealthChip tone="bad" className="ml-1.5 px-1.5 py-0 font-mono">
                {violationTotal.toLocaleString()}
              </HealthChip>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="topology">
          {mapQuery.isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-36 w-full" />
              <Skeleton className="h-72 w-full" />
            </div>
          ) : mapQuery.error ? (
            <LoadError error={mapQuery.error} onRetry={() => void mapQuery.refetch()} />
          ) : mapQuery.data ? (
            <TopologyTab data={mapQuery.data} />
          ) : null}
        </TabsContent>

        <TabsContent value="skeleton">
          {skeletonQuery.isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-96 w-full" />
            </div>
          ) : skeletonQuery.error ? (
            <LoadError error={skeletonQuery.error} onRetry={() => void skeletonQuery.refetch()} />
          ) : skeletonQuery.data ? (
            <GbrainSkeletonTab data={skeletonQuery.data} />
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
