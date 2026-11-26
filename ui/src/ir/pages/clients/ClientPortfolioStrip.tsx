import { useQuery } from "@tanstack/react-query";
import { IR_METRIC_DEFINITIONS } from "@paperclipai/shared/ir-metrics";
import { IrApiError, irSystemMapApi, type TenantProfile } from "../../api/irOps";
import { HealthChip } from "../system-map/HealthChip";
import { partitionClientPortfolio } from "./clientHelpers";

/**
 * Live client counts by own brand and by active / paused / cancelled, read
 * from GBrain client pages (the same feed as the System Map). Nothing is
 * assumed: a tenant without a classified GBrain page shows as unclassified.
 */
export function ClientPortfolioStrip({ tenants, loading }: { tenants: TenantProfile[]; loading: boolean }) {
  const registry = useQuery({
    queryKey: ["ir", "system-map", "gbrain-skeleton"],
    queryFn: irSystemMapApi.gbrainSkeleton,
    staleTime: 60_000,
    retry: false,
  });

  if (loading || registry.isLoading) return null;
  if (registry.error instanceof IrApiError && registry.error.status === 403) return null;
  if (registry.error) {
    return (
      <p className="text-xs text-muted-foreground" role="status" data-testid="client-portfolio-strip">
        Brand and lifecycle counts need the GBrain feed: {registry.error instanceof Error ? registry.error.message : "unavailable"}
      </p>
    );
  }
  const partition = partitionClientPortfolio(tenants, registry.data?.skeleton.clients ?? []);
  const { lifecycle } = partition;
  return (
    <section
      aria-label="Clients by brand and status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
      data-testid="client-portfolio-strip"
      title={IR_METRIC_DEFINITIONS.clientStatusCounts.formula}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <span>By brand</span>
        {partition.byBrand.map((row) => (
          <HealthChip key={row.code} tone={row.count > 0 ? "ok" : "muted"}>
            {row.code} {row.count}
          </HealthChip>
        ))}
        <HealthChip tone={partition.unclassified > 0 ? "warn" : "muted"}>
          Not classified in GBrain {partition.unclassified}
        </HealthChip>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <span>Status</span>
        <HealthChip tone="ok">Active {lifecycle.active}</HealthChip>
        <HealthChip tone="muted">Paused {lifecycle.paused}</HealthChip>
        <HealthChip tone="muted">Cancelled {lifecycle.cancelled}</HealthChip>
        {lifecycle.other > 0 ? <HealthChip tone="warn">Not recorded {lifecycle.other}</HealthChip> : null}
      </span>
    </section>
  );
}
