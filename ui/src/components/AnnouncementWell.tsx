import { useEffect, useRef, useState } from "react";
import { ChevronUp, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAccountIdentity } from "@/api/companies-query";
import type { HealthStatus } from "@/api/health";
import { issuesApi } from "@/api/issues";
import { useCompany } from "@/context/CompanyContext";
import { useDialogState } from "@/context/DialogContext";
import { useOptionalToastActions, useOptionalToastState } from "@/context/ToastContext";
import { useAnnouncement } from "@/hooks/useAnnouncement";
import { queryKeys } from "@/lib/queryKeys";
import { AnnouncementCard } from "./AnnouncementCard";

// Includes the command palette, sheets and dialogs created outside DialogContext.
const MODAL_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [aria-modal="true"]:not([data-state="closed"]), dialog[open]';
function useModalOpen(enabled: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const scan = () => setOpen(Boolean(document.querySelector(MODAL_SELECTOR)));
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "aria-modal", "open"] });
    return () => observer.disconnect();
  }, [enabled]);
  return open;
}

const FINISHED_ONBOARDING_STATUSES = new Set(["done", "cancelled"]);

/**
 * A new user's first session is the onboarding first task. Announcements wait
 * until that task is finished so they cannot cover its questions. Unknown
 * state (loading or a failed read) keeps the optional card hidden.
 */
function useOnboardingInProgress(companyId: string | null) {
  const query = useQuery({
    queryKey: queryKeys.issues.onboardingFirstTask(companyId ?? "__none__"),
    queryFn: ({ signal }) => issuesApi.list(companyId!, { originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND, limit: 1 }, { signal }),
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });
  if (!companyId) return false;
  if (!query.isSuccess) return true;
  return query.data.some((issue) => issue.originKind === ONBOARDING_FIRST_TASK_ORIGIN_KIND && !FINISHED_ONBOARDING_STATUSES.has(issue.status));
}

/**
 * Where the card lives. `sidebar` docks it in the desktop sidebar column, in
 * normal layout flow, so it never covers the task thread or composer.
 * `floating` keeps the mobile placement above the bottom navigation.
 */
export type AnnouncementPlacement = "sidebar" | "floating";

export function AnnouncementWell({ health, placement = "floating" }: { health?: HealthStatus; placement?: AnnouncementPlacement }) {
  const { userId: accountId, settled } = useAccountIdentity();
  const { selectedCompanyId, loading } = useCompany();
  const { onboardingOpen } = useDialogState();
  const toastActions = useOptionalToastActions();
  const toasts = useOptionalToastState();
  const onboardingInProgress = useOnboardingInProgress(selectedCompanyId);
  const userId = health?.deploymentMode === "local_trusted" ? "local-board" : (settled ? accountId : null);
  const { announcement, dismiss } = useAnnouncement({
    userId, companyId: selectedCompanyId,
    enabled: Boolean(userId && !loading && selectedCompanyId && !onboardingOpen && !onboardingInProgress),
    onSaveFailure: (savedLocally) => toastActions?.pushToast({
      title: savedLocally ? "Dismissed in this browser" : "Dismissed for this visit",
      body: "Couldn’t save across devices. We’ll retry when you reconnect or return.",
      tone: "info", dedupeKey: "announcement-dismissal-sync",
    }),
  });
  const modalOpen = useModalOpen(Boolean(announcement));
  const wellRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  // A new announcement starts compact again. The compact bar is a phone-only
  // resting state; tapping it opens the full card.
  useEffect(() => {
    setExpanded(false);
  }, [announcement?.id]);
  const visible = Boolean(announcement) && !modalOpen && (toasts?.length ?? 0) === 0;
  const compact = placement === "floating" && !expanded;
  // A floating card is fixed above the bottom navigation, so page content
  // scrolls underneath it. Publish its height so the page shell can reserve
  // that space and keep the last controls reachable without a dismissal.
  useEffect(() => {
    if (placement !== "floating" || !visible) return;
    const root = document.documentElement;
    const update = () => {
      const height = wellRef.current?.getBoundingClientRect().height ?? 0;
      root.style.setProperty("--floating-announcement-height", `${Math.ceil(height)}px`);
      root.dataset.floatingAnnouncement = "true";
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (wellRef.current) observer?.observe(wellRef.current);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--floating-announcement-height");
      delete root.dataset.floatingAnnouncement;
    };
  }, [placement, visible]);
  if (!visible || !announcement) return null;
  return (
    <aside
      ref={wellRef}
      aria-label="Paperclip announcements"
      data-placement={placement}
      data-compact={compact || undefined}
      data-expanded={placement === "floating" && expanded ? "true" : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        dismiss(announcement.id);
      }}
      className={cn(
        "announcement-well",
        placement === "sidebar"
          ? "shrink-0 overflow-y-auto px-3 pb-2 max-h-(--announcement-sidebar-max-height)"
          : compact
            ? "fixed left-3 bottom-(--announcement-mobile-bottom) z-40 w-(--announcement-available-width) max-w-(--announcement-width) max-h-(--announcement-compact-max-height) overflow-hidden rounded-xl border border-border bg-card shadow-sm"
            : "fixed left-3 bottom-(--announcement-mobile-bottom) z-40 w-(--announcement-available-width) max-w-(--announcement-width) max-h-(--announcement-mobile-max-height) overflow-y-auto md:bottom-3 md:max-h-(--announcement-max-height)",
      )}
    >
      {compact ? (
        <div className="flex min-h-(--announcement-compact-height) items-center gap-2 py-2 pl-3 pr-2">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            aria-label={`Expand announcement: ${announcement.title}`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-muted-foreground">{announcement.eyebrow}</span>
              <span className="block truncate text-sm font-semibold">{announcement.title}</span>
            </span>
            <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss announcement"
            onClick={() => dismiss(announcement.id)}
            className="shrink-0"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <AnnouncementCard
          key={announcement.id}
          announcement={announcement}
          onDismiss={() => dismiss(announcement.id)}
          onCollapse={placement === "floating" ? () => setExpanded(false) : undefined}
        />
      )}
    </aside>
  );
}
