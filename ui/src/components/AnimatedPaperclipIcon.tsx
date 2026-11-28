import type { SVGProps } from "react";
import { cn } from "../lib/utils";
import { BRAND_ACCENT_GREEN, BRAND_ACCENT_TILE, BRAND_GRID_TILES } from "./BrandMark";

export function AnimatedPaperclipIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      className={cn("paperclip-thinking-icon", className)}
      aria-hidden="true"
      {...props}
    >
      {BRAND_GRID_TILES.map((tile, index) => (
        <rect
          key={index}
          className="paperclip-thinking-tile"
          style={{ animationDelay: `${index * 90}ms` }}
          x={tile.x}
          y={tile.y}
          width={tile.width}
          height={tile.height}
          fill="currentColor"
        />
      ))}
      <rect
        className="paperclip-thinking-accent"
        x={BRAND_ACCENT_TILE.x}
        y={BRAND_ACCENT_TILE.y}
        width={BRAND_ACCENT_TILE.width}
        height={BRAND_ACCENT_TILE.height}
        fill={BRAND_ACCENT_GREEN}
      />
    </svg>
  );
}

/** Full-page loading state: centered animated brand mark. */
export function PaperclipLoading({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn("flex min-h-dvh w-full items-center justify-center", className)}
    >
      <AnimatedPaperclipIcon className="h-20 w-20 text-foreground" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
