import { useQuery } from "@tanstack/react-query";
import { IrApiError, irSystemMapApi, type TenantProfile } from "../../api/irOps";
import { HealthChip } from "../system-map/HealthChip";
import { partitionClientPortfolio } from "./clientHelpers";

/**
 * Live client counts by own brand, read from the GBrain customer list (the
 * same feed as the System Map). Active / paused / cancelled is not shown until
 * a payment-source reader supplies live billing state; it is never copied into
 * GBrain and never shown as a dead tile.
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
  return (
    <section
      aria-label="Clients by brand"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
      data-testid="client-portfolio-strip"
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
    </section>
  );
}
