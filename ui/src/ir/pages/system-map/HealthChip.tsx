import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { toneStyle, type Tone } from "./systemMapHelpers";

/** Bordered status chip recoloured from Paperclip's native status hues. */
export function HealthChip({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "status-chip inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5 whitespace-nowrap shrink-0",
        className,
      )}
      style={toneStyle(tone)}
      data-tone={tone}
    >
      {children}
    </span>
  );
}
