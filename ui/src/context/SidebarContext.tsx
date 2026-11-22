import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface SidebarContextValue {
  // Mobile drawer + back-compat (existing behavior, unchanged).
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  isMobile: boolean;
  /** Tablet shell: 768px through 1023px. The primary nav is a drawer here. */
  isTablet: boolean;
  /** Mobile or tablet: the primary nav is off-canvas rather than in flow. */
  isCompactShell: boolean;
  // Back-compat collapse API. The global navigation is permanently expanded;
  // these values remain for callers that have not removed old requests.
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggleCollapsed: () => void;
  // Retained compatibility value; always false now that the rail is retired.
  collapseLocked: boolean;
  // Retained compatibility value; the retired rail can no longer peek.
  peeking: boolean;
  setPeeking: (next: boolean) => void;
  // Legacy requests remain observable without affecting the global nav.
  forceCollapsed: boolean;
  setForceCollapsed: (next: boolean) => void;
  // Route-requested collapse retained for integration compatibility.
  routeRequestsCollapsed: boolean;
  setRouteRequestsCollapsed: (next: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_BREAKPOINT = 768;
const DESKTOP_BREAKPOINT = 1024;

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [isTablet, setIsTablet] = useState(
    () => window.innerWidth >= MOBILE_BREAKPOINT && window.innerWidth < DESKTOP_BREAKPOINT,
  );
  // The primary nav is in flow only on desktop. Below `lg` it is a drawer, so
  // the agent-detail content column keeps a readable width on a tablet.
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= DESKTOP_BREAKPOINT);

  const [routeRequestsCollapsed, setRouteRequestsCollapsed] = useState(false);
  const [forceCollapsed, setForceCollapsed] = useState(false);

  useEffect(() => {
    const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const tabletQuery = window.matchMedia(
      `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${DESKTOP_BREAKPOINT - 1}px)`,
    );
    const onChange = () => {
      const mobile = mobileQuery.matches;
      const tablet = tabletQuery.matches;
      setIsMobile(mobile);
      setIsTablet(tablet);
      // Entering a compact shell closes the drawer. Entering desktop restores
      // the in-flow primary nav.
      setSidebarOpen(!mobile && !tablet);
    };
    mobileQuery.addEventListener("change", onChange);
    tabletQuery.addEventListener("change", onChange);
    return () => {
      mobileQuery.removeEventListener("change", onChange);
      tabletQuery.removeEventListener("change", onChange);
    };
  }, []);

  // The icon rail has been retired. Keep the old API inert so routes and
  // plugins compiled against it cannot collapse the global navigation.
  const collapsed = false;
  const collapseLocked = false;
  const peeking = false;
  const setCollapsed = useCallback((_next: boolean) => {}, []);
  const toggleCollapsed = useCallback(() => {}, []);
  const setPeeking = useCallback((_next: boolean) => {}, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  const value = useMemo<SidebarContextValue>(
    () => ({
      sidebarOpen,
      setSidebarOpen,
      toggleSidebar,
      isMobile,
      isTablet,
      isCompactShell: isMobile || isTablet,
      collapsed,
      setCollapsed,
      toggleCollapsed,
      collapseLocked,
      peeking,
      setPeeking,
      forceCollapsed,
      setForceCollapsed,
      routeRequestsCollapsed,
      setRouteRequestsCollapsed,
    }),
    [
      sidebarOpen,
      setSidebarOpen,
      toggleSidebar,
      isMobile,
      isTablet,
      collapsed,
      setCollapsed,
      toggleCollapsed,
      collapseLocked,
      peeking,
      setPeeking,
      forceCollapsed,
      setForceCollapsed,
      routeRequestsCollapsed,
      setRouteRequestsCollapsed,
    ],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return ctx;
}
