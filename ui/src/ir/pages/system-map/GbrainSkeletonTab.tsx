import { useState } from "react";
import type { GbrainSkeletonResponse, SkeletonViolationGroup } from "@paperclipai/shared/ir-system-map";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { HealthChip } from "./HealthChip";
import { brandCoverage, definitionState, unexpectedBrandPages } from "./systemMapHelpers";

const VIOLATION_LABELS: Array<{ key: keyof GbrainSkeletonResponse["skeleton"]["violations"]; label: string }> = [
  { key: "brokenLinks", label: "Broken links" },
  { key: "missingRequired", label: "Missing required fields" },
  { key: "undeclaredTypes", label: "Undeclared page types" },
  { key: "invalidBrands", label: "Invalid brand codes" },
];

function ViolationCard({ label, group }: { label: string; group: SkeletonViolationGroup }) {
  const [open, setOpen] = useState(false);
  const bad = group.count > 0;
  return (
    <Card className={cn("gap-2 py-3", bad && "border-destructive/40 bg-destructive/5")} data-testid={`violation-${label}`}>
      <CardContent className="flex flex-col gap-2 px-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <HealthChip tone={bad ? "bad" : "ok"}>{bad ? "Fix" : "Clean"}</HealthChip>
        </div>
        <span className={cn("text-2xl font-semibold tabular-nums", bad ? "text-destructive" : "text-foreground")}>
          {group.count.toLocaleString()}
        </span>
        {group.sample.length > 0 ? (
          <button
            type="button"
            className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Hide examples" : `Show ${group.sample.length} examples`}
          </button>
        ) : null}
        {open ? (
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {group.sample.map((item) => (
              <li key={`${item.page}-${item.detail}`} className="break-words font-mono text-xs text-foreground/80">
                {item.page}: <span className="text-destructive">{item.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function GbrainSkeletonTab({ data }: { data: GbrainSkeletonResponse }) {
  const { skeleton } = data;
  const pageTypes = [...skeleton.pageTypes].sort((a, b) => b.count - a.count);
  const liveTypes = pageTypes.filter((type) => type.count > 0);
  const emptyTypes = pageTypes.filter((type) => type.count === 0);
  const maxEdge = Math.max(1, ...skeleton.edges.map((edge) => edge.count));
  const brands = brandCoverage(skeleton.brands);
  const strayBrands = unexpectedBrandPages(skeleton.brands);

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Schema pack" className="flex flex-wrap items-center gap-2 text-sm">
        <HealthChip tone={skeleton.pack.version === "1.0.0" ? "ok" : "warn"}>
          {skeleton.pack.name} v{skeleton.pack.version}
        </HealthChip>
        <HealthChip tone={skeleton.lint.ok ? "ok" : "bad"}>
          {skeleton.lint.ok ? "Pack lint clean" : `${skeleton.lint.errors.length} lint errors`}
        </HealthChip>
        <span className="text-muted-foreground">
          {skeleton.totals.totalPages.toLocaleString()} pages
          {skeleton.totals.coverage !== null ? ` · ${(skeleton.totals.coverage * 100).toFixed(2)}% typed` : ""}
          {skeleton.requiredFieldsVersion ? ` · required fields v${skeleton.requiredFieldsVersion}` : ""}
          {` · ${skeleton.lint.warningCount} lint warnings`}
        </span>
      </section>

      {skeleton.lint.errors.length > 0 ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs">
          {skeleton.lint.errors.map((error) => (
            <p key={`${error.rule}-${error.message}`}>
              <span className="font-mono">{error.rule}</span>: {error.message}
            </p>
          ))}
        </div>
      ) : null}

      <section aria-label="Schema violations" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {VIOLATION_LABELS.map(({ key, label }) => (
          <ViolationCard key={key} label={label} group={skeleton.violations[key]} />
        ))}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Page types</CardTitle>
            <CardDescription className="text-xs">Declared by the pack; counts are live from GBrain</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-normal">Type</th>
                  <th className="pb-2 font-normal">Folders</th>
                  <th className="pb-2 text-right font-normal">Pages</th>
                  <th className="pb-2 text-right font-normal">Issues</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {liveTypes.map((type) => (
                  <tr key={type.name}>
                    <td className="py-1.5 text-foreground">{type.name}</td>
                    <td className="py-1.5 font-mono text-xs text-muted-foreground">{type.pathPrefixes.join(" ")}</td>
                    <td className="py-1.5 text-right tabular-nums">{type.count.toLocaleString()}</td>
                    <td className={cn("py-1.5 text-right tabular-nums", type.violationCount > 0 ? "text-destructive" : "text-muted-foreground")}>
                      {type.violationCount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {emptyTypes.length > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Declared with no pages yet: {emptyTypes.map((type) => type.name).join(", ")}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">Required fields</CardTitle>
              <CardDescription className="text-xs">brain/schema-required.json, checked on every page</CardDescription>
            </CardHeader>
            <CardContent className="px-4">
              {skeleton.requiredFolders.length === 0 ? (
                <p className="text-xs text-muted-foreground">No required-field rules published.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {skeleton.requiredFolders.map((folder) => (
                    <li key={folder.prefix} className="flex flex-col gap-0.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-foreground">{folder.prefix}</span>
                        <HealthChip tone={folder.violations > 0 ? "bad" : "ok"}>
                          {folder.violations > 0 ? `${folder.violations}/${folder.pages} pages missing fields` : `${folder.pages} pages complete`}
                        </HealthChip>
                      </div>
                      <span className="text-xs text-muted-foreground">{folder.fields.join(", ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">Own brands</CardTitle>
              <CardDescription className="text-xs">The 6 locked own brands and their GBrain brands/ pages</CardDescription>
            </CardHeader>
            <CardContent className="px-4">
              <ul className="grid gap-2 sm:grid-cols-2">
                {brands.map((brand) => (
                  <li key={brand.code} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="font-mono text-xs text-muted-foreground">{brand.code}</span> {brand.name}
                    </span>
                    <HealthChip tone={brand.page ? "ok" : "bad"}>{brand.page ? "Page live" : "Page missing"}</HealthChip>
                  </li>
                ))}
              </ul>
              {strayBrands.length > 0 ? (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  Not an own brand: {strayBrands.map((page) => `${page.slug} (${page.code || "no code"})`).join(", ")}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Typed link graph</CardTitle>
          <CardDescription className="text-xs">
            Live page-type to page-type links found in brain pages · {skeleton.linkTypes.length} declared link verbs
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-4">
          <ul className="flex flex-col gap-1.5">
            {skeleton.edges.slice(0, 24).map((edge) => (
              <li key={`${edge.fromType}-${edge.toType}`} className="grid grid-cols-12 items-center gap-2 text-xs">
                <span className="col-span-4 truncate text-foreground sm:col-span-3">
                  {edge.fromType} → {edge.toType}
                </span>
                <span className="col-span-6 h-2 rounded-full bg-muted sm:col-span-8">
                  <span
                    className="block h-2 rounded-full bg-primary/70"
                    style={{ width: `${Math.max(2, Math.round((edge.count / maxEdge) * 100))}%` }}
                  />
                </span>
                <span className="col-span-2 text-right tabular-nums text-muted-foreground sm:col-span-1">
                  {edge.count.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-1.5">
            {skeleton.linkTypes.map((link) => (
              <span key={link.name} className="rounded-md border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
                {link.name}
                {link.inverse && link.inverse !== link.name ? ` ↔ ${link.inverse}` : ""}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Metric definitions</CardTitle>
          <CardDescription className="text-xs">
            GBrain definitions/ pages and the shared ir-metrics function each one points at
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {skeleton.definitions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No definitions/ pages yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {skeleton.definitions.map((definition) => {
                const state = definitionState(definition);
                return (
                  <li key={definition.slug} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0" data-testid={`definition-${definition.slug}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm text-foreground">
                        {definition.title}
                        {definition.brands.length > 0 ? (
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{definition.brands.join(" ")}</span>
                        ) : null}
                      </span>
                      {state.kind === "broken" ? (
                        <HealthChip tone="bad">Broken pointer</HealthChip>
                      ) : state.kind === "not_defined" ? (
                        <HealthChip tone="muted">Not defined yet</HealthChip>
                      ) : (
                        <HealthChip tone={state.certified ? "ok" : "warn"}>
                          {state.certified ? "Certified" : "Pending owner sign-off"}
                        </HealthChip>
                      )}
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">
                      {state.kind === "linked" ? `${definition.calculation} = ${state.formula}` : definition.calculation}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
