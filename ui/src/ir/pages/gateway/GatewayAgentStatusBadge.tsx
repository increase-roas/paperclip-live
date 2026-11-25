import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { getAgentStatus } from "./gatewayHelpers";

export function GatewayAgentStatusBadge({
  status,
  className,
}: {
  status: ReturnType<typeof getAgentStatus>;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-normal",
        className,
        status.kind === "active" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        status.kind === "disabled" && "border-destructive/40 bg-destructive/10 text-destructive",
        status.kind === "no_key" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {status.label}
    </Badge>
  );
}
