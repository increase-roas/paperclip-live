/**
 * Minimal Prometheus-compatible metrics registry.
 *
 * Surfaces that do not run an HTTP server can still record counters and
 * timings; `render()` exposes the standard text exposition format so a
 * `/metrics` route only has to return it.
 */

export type MetricType = "counter" | "gauge" | "histogram";
export type MetricLabels = Record<string, string | number | boolean>;

export interface MetricSnapshotEntry {
  name: string;
  type: MetricType;
  help: string;
  labels: Record<string, string>;
  value: number;
  buckets?: Array<{ le: number; count: number }>;
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

function labelKey(labels: MetricLabels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${value}"`).join(",")}}`;
}

interface Series {
  labels: Record<string, string>;
  value: number;
  buckets?: number[];
  count?: number;
  sum?: number;
}

interface MetricFamily {
  name: string;
  type: MetricType;
  help: string;
  series: Map<string, Series>;
  boundaries?: number[];
}

export class MetricsRegistry {
  private readonly families = new Map<string, MetricFamily>();

  counter(name: string, help: string) {
    const family = this.family(name, "counter", help);
    return {
      inc: (labels: MetricLabels = {}, value = 1): void => {
        if (value < 0) throw new Error("Counters cannot decrease.");
        const series = this.series(family, labels);
        series.value += value;
      },
    };
  }

  gauge(name: string, help: string) {
    const family = this.family(name, "gauge", help);
    return {
      set: (labels: MetricLabels, value: number): void => {
        this.series(family, labels).value = value;
      },
      add: (labels: MetricLabels, value: number): void => {
        this.series(family, labels).value += value;
      },
    };
  }

  histogram(name: string, help: string, boundaries: number[] = DEFAULT_BUCKETS) {
    const family = this.family(name, "histogram", help);
    family.boundaries = [...boundaries].sort((left, right) => left - right);
    return {
      observe: (labels: MetricLabels, value: number): void => {
        const series = this.series(family, labels);
        series.count = (series.count ?? 0) + 1;
        series.sum = (series.sum ?? 0) + value;
        series.buckets ??= family.boundaries!.map(() => 0);
        family.boundaries!.forEach((boundary, index) => {
          if (value <= boundary) series.buckets![index] += 1;
        });
      },
    };
  }

  snapshot(): MetricSnapshotEntry[] {
    const entries: MetricSnapshotEntry[] = [];
    for (const family of this.families.values()) {
      for (const series of family.series.values()) {
        if (family.type === "histogram") {
          entries.push({
            name: family.name,
            type: family.type,
            help: family.help,
            labels: series.labels,
            value: series.sum ?? 0,
            buckets: family.boundaries!.map((le, index) => ({
              le,
              count: series.buckets?.[index] ?? 0,
            })),
          });
        } else {
          entries.push({
            name: family.name,
            type: family.type,
            help: family.help,
            labels: series.labels,
            value: series.value,
          });
        }
      }
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  render(): string {
    const lines: string[] = [];
    for (const family of this.families.values()) {
      lines.push(`# HELP ${family.name} ${family.help}`);
      lines.push(`# TYPE ${family.name} ${family.type}`);
      for (const series of family.series.values()) {
        if (family.type === "histogram") {
          const count = series.count ?? 0;
          const sum = series.sum ?? 0;
          family.boundaries!.forEach((boundary, index) => {
            lines.push(
              `${family.name}_bucket${formatLabels({ ...series.labels, le: String(boundary) })} ${series.buckets?.[index] ?? 0}`,
            );
          });
          lines.push(
            `${family.name}_bucket${formatLabels({ ...series.labels, le: "+Inf" })} ${count}`,
          );
          lines.push(`${family.name}_sum${formatLabels(series.labels)} ${sum}`);
          lines.push(`${family.name}_count${formatLabels(series.labels)} ${count}`);
        } else {
          lines.push(`${family.name}${formatLabels(series.labels)} ${series.value}`);
        }
      }
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }

  private family(name: string, type: MetricType, help: string): MetricFamily {
    const existing = this.families.get(name);
    if (existing) return existing;
    const family: MetricFamily = { name, type, help, series: new Map() };
    this.families.set(name, family);
    return family;
  }

  private series(family: MetricFamily, labels: MetricLabels): Series {
    const normalized = Object.fromEntries(
      Object.entries(labels)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, String(value)]),
    );
    const key = labelKey(labels);
    const existing = family.series.get(key);
    if (existing) return existing;
    const series: Series = {
      labels: normalized,
      value: 0,
    };
    if (family.type === "histogram") {
      series.buckets = family.boundaries!.map(() => 0);
      series.count = 0;
      series.sum = 0;
    }
    family.series.set(key, series);
    return series;
  }
}

export function createMetricsRegistry(): MetricsRegistry {
  return new MetricsRegistry();
}
