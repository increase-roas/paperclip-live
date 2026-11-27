import { AlertTriangle, Server } from "lucide-react";
import type { SystemMapResponse } from "@paperclipai/shared/ir-system-map";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HealthChip } from "./HealthChip";
import { ageSecondsSince, displayDiagnostic, formatAge, formatCheckName, healthLabel, healthTone } from "./systemMapHelpers";

export function TopologyTab({ data }: { data: SystemMapResponse }) {
  const { feed, freshness } = data;
  const servicesByKey = new Map(feed.services.map((service) => [service.key, service]));

  return (
    <div className="flex flex-col gap-4">
      {freshness.stale ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            Health data is stale: the last ir-doctor run was {formatAge(freshness.ageSeconds)} (limit{" "}
            {Math.round(freshness.thresholdSeconds / 60)} min). Check the ir-system-feed service on brain-vps.
          </span>
        </div>
      ) : null}

      {feed.doctor.error ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
          ir-doctor did not return checks: {feed.doctor.error}
        </div>
      ) : null}

      <section aria-label="Servers and services" className="grid gap-4 md:grid-cols-3">
        {feed.hosts.map((host) => {
          const services = host.services.map((key) => servicesByKey.get(key)).filter((s) => s !== undefined);
          const worst = services.some((s) => s.status === "down")
            ? "down"
            : services.some((s) => s.status === "unknown")
              ? "unknown"
              : "ok";
          return (
            <Card key={host.key} className="gap-3 py-4" data-testid={`host-${host.key}`}>
              <CardHeader className="px-4">
                <CardTitle className="flex items-center justify-between gap-2 text-sm">
                  <span className="inline-flex items-center gap-2">
                    <Server className="size-4 text-muted-foreground" />
                    {host.label}
                  </span>
                  {services.length > 0 ? <HealthChip tone={healthTone(worst)}>{healthLabel(worst)}</HealthChip> : null}
                </CardTitle>
                <CardDescription className="text-xs">{host.role}</CardDescription>
              </CardHeader>
              <CardContent className="px-4">
                {services.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No health-checked services on this host.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {services.map((service) => (
                      <li key={service.key} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate text-foreground">{displayDiagnostic(service.label)}</span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                          {service.latencyMs !== null ? <span className="font-mono">{service.latencyMs} ms</span> : null}
                          <HealthChip tone={healthTone(service.status)}>{healthLabel(service.status)}</HealthChip>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Health checks</CardTitle>
            <CardDescription className="text-xs">ir-doctor, read-only, every 5 minutes</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <ul className="flex flex-col divide-y divide-border">
              {feed.doctor.checks.map((check) => (
                <li key={check.key} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-foreground">{formatCheckName(check.key)}</span>
                    <HealthChip tone={healthTone(check.status)}>{healthLabel(check.status)}</HealthChip>
                  </div>
                  {check.anomalies.length > 0 ? (
                    <p className="break-words font-mono text-xs text-muted-foreground">{check.anomalies.map(displayDiagnostic).join(" · ")}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">Data sources</CardTitle>
              <CardDescription className="text-xs">Where this map reads from, and how old each source is</CardDescription>
            </CardHeader>
            <CardContent className="px-4">
              <ul className="flex flex-col gap-2">
                {feed.sources.map((source) => (
                  <li key={source.key} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate text-foreground">{source.label}</span>
                      {source.detail ? <span className="block truncate text-xs text-muted-foreground">{source.detail}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatAge(ageSecondsSince(source.observedAt))}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">company-ops registers</CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              {feed.registers.length === 0 ? (
                <p className="text-xs text-muted-foreground">No registers published yet (company-ops registers/*.yaml).</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {feed.registers.map((register) => (
                    <li key={register.path} className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-mono text-xs text-foreground">{register.path}</span>
                      <span className="text-xs text-muted-foreground">
                        {register.entries ?? "?"} entries · {formatAge(ageSecondsSince(register.updatedAt))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
