import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

type IssueGroupHeaderProps = {
  label: string;
  icon?: ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  trailing?: ReactNode;
  className?: string;
  labelClassName?: string;
};

export function IssueGroupHeader({
  label,
  icon,
  collapsible = false,
  collapsed = false,
  onToggle,
  trailing,
  className,
  labelClassName = "truncate text-sm font-semibold uppercase tracking-wide",
}: IssueGroupHeaderProps) {
  return (
    <div className={cn("flex items-center py-1.5 pl-1 pr-3", className)}>
      {collapsible ? (
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 text-left"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {/* w-4 centered chevron box matches the task rows' chevron column so
              the header chevron lines up exactly with the chevrons below it. */}
          <span className="inline-flex w-4 shrink-0 items-center justify-center">
            <ChevronRight
              className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")}
            />
          </span>
          {icon ? <span className="inline-flex shrink-0 items-center">{icon}</span> : null}
          <span className={labelClassName}>
            {label}
          </span>
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5">
          {icon ? <span className="inline-flex shrink-0 items-center">{icon}</span> : null}
          <span className={labelClassName}>
            {label}
          </span>
        </div>
      )}
      {trailing ? <div className="ml-auto">{trailing}</div> : null}
    </div>
  );
}
