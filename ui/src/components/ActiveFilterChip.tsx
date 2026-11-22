import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * A removable chip for a filter that has no control inside the filter popover.
 *
 * URL-scoped filters (for example a participant agent link from an agent page)
 * otherwise narrow the collection without any visible way to clear them.
 */
export function ActiveFilterChip({
  label,
  onRemove,
  testId,
}: {
  label: string;
  onRemove: () => void;
  testId?: string;
}) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1 font-normal" data-testid={testId}>
      <span className="truncate">{label}</span>
      <button
        type="button"
        className="rounded-full p-0.5 hover:bg-background/60"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}
