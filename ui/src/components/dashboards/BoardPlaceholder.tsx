import { Construction } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";

export interface BoardPlaceholderProps {
  title: string;
}

/**
 * A tab that exists in the bar but has no board yet. It says "Being built"
 * rather than showing an empty page, so a half-shipped dashboard never reads
 * as a dashboard with nothing to report.
 */
export function BoardPlaceholder({ title }: BoardPlaceholderProps) {
  return (
    <div data-testid="dashboard-board-being-built">
      <EmptyState
        icon={Construction}
        title="Being built"
        message={`The ${title} board is being built. It will show its numbers here once it is registered.`}
      />
    </div>
  );
}
