import type { DashboardTileValue } from "@paperclipai/shared";

type LiveReading = Extract<DashboardTileValue, { kind: "live" }>;

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * Formats a live reading with its unit. Kept apart from the tile so the
 * formatting is testable without rendering, and so a unit can never be
 * silently dropped when a source starts reporting.
 */
export function formatTileValue(reading: LiveReading): string {
  switch (reading.unit) {
    case "usd":
      return `$${numberFormat.format(reading.value)}`;
    case "percent":
      return `${numberFormat.format(reading.value)}%`;
    case "ratio":
      return `${numberFormat.format(reading.value)}×`;
    case "seconds":
      return `${numberFormat.format(reading.value)} s`;
    case "minutes":
      return `${numberFormat.format(reading.value)} min`;
    case "hours":
      return `${numberFormat.format(reading.value)} h`;
    case "days":
      return `${numberFormat.format(reading.value)} days`;
    case "count":
      return numberFormat.format(reading.value);
  }
}
