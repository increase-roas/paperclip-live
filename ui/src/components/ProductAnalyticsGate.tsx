import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { sanitizeAnalyticsRoute, uiProductAnalytics } from "@/lib/product-analytics";

/**
 * Opt-in product analytics gate. Identifies the signed-in user by opaque id
 * and records a sanitized route view. No page content, query string, task id,
 * or company id is sent. Renders nothing.
 */
export function ProductAnalyticsGate() {
  const location = useLocation();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id;

  useEffect(() => {
    if (userId) uiProductAnalytics.identify(userId);
  }, [userId]);

  useEffect(() => {
    uiProductAnalytics.capture("page_view", { route: sanitizeAnalyticsRoute(location.pathname) });
  }, [location.pathname]);

  return null;
}
