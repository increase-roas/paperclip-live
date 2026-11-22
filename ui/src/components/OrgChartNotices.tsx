import { OrgChartErrorPanel } from "./OrgChartErrorPanel";

/**
 * Loading and failure states for the agent org chart. Both the roster page and
 * its production variant render them between the list view and the chart.
 */
export function OrgChartNotices({
  view,
  loading,
  hasTree,
  error,
  fetching,
  onRetry,
  onSwitchToList,
}: {
  view: string;
  loading: boolean;
  hasTree: boolean;
  error: unknown;
  fetching: boolean;
  onRetry: () => void;
  onSwitchToList: () => void;
}) {
  if (view !== "org" || hasTree) return null;
  if (loading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading org chart…</p>;
  }
  if (!error) return null;
  return (
    <OrgChartErrorPanel
      error={error}
      retrying={fetching}
      onRetry={onRetry}
      onSwitchToList={onSwitchToList}
    />
  );
}
