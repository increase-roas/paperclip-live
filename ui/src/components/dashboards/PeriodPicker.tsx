import { Button } from "@/components/ui/button";
import { DASHBOARD_PERIODS, type DashboardPeriod } from "./period";

export interface PeriodPickerProps {
  value: DashboardPeriod;
  onChange: (period: DashboardPeriod) => void;
}

/** 7d / 30d / month, the three views every tile is read on. */
export function PeriodPicker({ value, onChange }: PeriodPickerProps) {
  return (
    <div
      role="group"
      aria-label="Dashboard period"
      className="inline-flex items-center gap-1 rounded-md bg-muted p-1"
    >
      {DASHBOARD_PERIODS.map((period) => {
        const active = period.id === value;
        return (
          <Button
            key={period.id}
            type="button"
            size="xs"
            variant={active ? "secondary" : "ghost"}
            aria-pressed={active}
            onClick={() => onChange(period.id)}
            data-testid={`dashboard-period-${period.id}`}
          >
            {period.label}
          </Button>
        );
      })}
    </div>
  );
}
