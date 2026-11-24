import { useEffect } from "react";
import { useLocation } from "@/lib/router";
import { useDialogActions } from "@/context/DialogContext";
import { claimOnboardingOffer, dashboardOnboardingOptions } from "@/lib/onboarding-auto-open";
import { onboardingDraftStorage } from "@/lib/onboarding-state";
import { shouldRouteAgentlessCompanyToOnboarding } from "@/lib/onboarding-route";
import { useCompanyAgents } from "./useCompanyDirectoryQueries";

/**
 * Offers onboarding once per company that has no agent yet, and returns the
 * company's agents query so the page reads the same cache entry.
 *
 * `isFetching` is read alongside the data: a cached list is served while its
 * refetch runs, and an empty one from before the first hire must not pass for
 * the company's current state (see `shouldRouteAgentlessCompanyToOnboarding`).
 * A saved agent that is still in setup counts as unfinished onboarding only
 * when the matching browser draft can resume it. The company and step are both
 * passed so the wizard gives this company an agent instead of creating a
 * second company, and `claimOnboardingOffer` keeps a refetch or a return visit
 * from reopening a wizard that was deliberately closed.
 */
export function useAgentlessOnboardingOffer(companyId: string | null | undefined) {
  const { openOnboarding } = useDialogActions();
  const location = useLocation();
  const agentsQuery = useCompanyAgents(companyId);
  const { data: agents, isFetching: agentsRefreshing } = agentsQuery;
  const onboardingOptions = companyId
    ? dashboardOnboardingOptions(companyId, agents, onboardingDraftStorage.read())
    : null;
  const initialStep = onboardingOptions?.initialStep;
  const shouldOpen = shouldRouteAgentlessCompanyToOnboarding({
    pathname: location.pathname,
    agentsLoaded: agents !== undefined,
    agentsRefreshing,
    agentCount: onboardingOptions ? 0 : agents?.length ?? 0,
  });
  useEffect(() => {
    if (!shouldOpen || !companyId || !initialStep) return;
    if (!claimOnboardingOffer(companyId)) return;
    openOnboarding({ companyId, initialStep });
  }, [shouldOpen, companyId, initialStep, openOnboarding]);
  return agentsQuery;
}
