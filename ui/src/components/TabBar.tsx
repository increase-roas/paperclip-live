import type { ReactNode } from "react";
import { ToggleGroup } from "radix-ui";
import { TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "@/lib/utils";

export type TabSize = "compact" | "standard";
export interface TabBarItem<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}
interface TabBarProps {
  items: readonly TabBarItem[];
  size?: TabSize;
  label?: string;
  className?: string;
}

/** Canonical content tabs. Compose inside Tabs with matching TabsContent panels. */
export function TabBar({ items, size = "standard", label, className }: TabBarProps) {
  return <TabsList variant="line" data-canonical-tabs={size} aria-label={label} className={cn("canonical-tab-list", className)}>
    {items.map(item => <TabsTrigger key={item.value} value={item.value} disabled={item.disabled} className="canonical-tab">{item.label}</TabsTrigger>)}
  </TabsList>;
}

/**
 * Navigation-style page sections. Use this instead of content tabs when the
 * selection changes the route or a filter and no tabpanel exists. The current
 * item carries `aria-current`, so there is no dangling `aria-controls`.
 */
export function NavigationTabBar<T extends string>({ items, value, onValueChange, size = "standard", label, className, current = "page" }: {
  items: readonly TabBarItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: TabSize;
  label: string;
  className?: string;
  current?: "page" | "true";
}) {
  return <nav aria-label={label} data-canonical-tabs={size} data-canonical-tabs-navigation="" className={cn("canonical-tab-list", className)}>
    {items.map(item => {
      const active = item.value === value;
      return <button key={item.value} type="button" disabled={item.disabled} title={item.title} data-state={active ? "active" : "inactive"} aria-current={active ? current : undefined} className="canonical-tab" onClick={() => onValueChange(item.value)}>{item.label}</button>;
    })}
  </nav>;
}

/** Same two visual sizes for collection filters; radio choices are not panels. */
export function TabFilters<T extends string>({ items, value, onValueChange, size = "standard", label, className }: {
  items: readonly TabBarItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: TabSize;
  label: string;
  className?: string;
}) {
  return <ToggleGroup.Root type="single" value={value} onValueChange={next => { if (next) onValueChange(next as T); }} data-canonical-tabs={size} aria-label={label} className={cn("canonical-tab-list", className)}>
    {items.map(item => <ToggleGroup.Item key={item.value} value={item.value} disabled={item.disabled} className="canonical-tab">{item.label}</ToggleGroup.Item>)}
  </ToggleGroup.Root>;
}
