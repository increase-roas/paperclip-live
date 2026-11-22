import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { NavigationTabBar, TabBar, type TabSize } from "./TabBar";
import { useSidebar } from "../context/SidebarContext";

export interface PageTabItem {
  value: string;
  label: ReactNode;
}

interface PageTabBarProps {
  items: readonly PageTabItem[];
  value?: string;
  onValueChange?: (value: string) => void;
  align?: "center" | "start";
  size?: TabSize;
  label?: string;
  /**
   * `tabs` (default) keeps content-tab semantics for callers that render
   * matching tabpanels. `navigation` is for page-level sections that change
   * the route or filter and have no panels.
   */
  mode?: "tabs" | "navigation";
}

export function PageTabBar({ items, value, onValueChange, align = "center", size = "standard", label, mode = "tabs" }: PageTabBarProps) {
  const { isMobile } = useSidebar();

  if (mode === "navigation") {
    if (isMobile && value !== undefined && onValueChange) {
      return (
        <div className="relative inline-flex">
          <select
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            className="h-9 appearance-none rounded-md border border-border bg-background pl-3 pr-9 py-1 text-base focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label={label ?? "Page section"}
          >
            {items.map((item) => (
              <option key={item.value} value={item.value}>
                {typeof item.label === "string" ? item.label : item.value}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
      );
    }
    if (!value || !onValueChange) return null;
    return <NavigationTabBar items={items} value={value} onValueChange={onValueChange} size={size} label={label ?? "Page section"} className={align === "start" ? "justify-start" : undefined} />;
  }

  return (
    <TabBar items={items} size={size} label={label} className={align === "start" ? "justify-start" : undefined} />
  );
}
