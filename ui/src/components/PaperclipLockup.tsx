import type { SVGProps } from "react";
import { BRAND_ACCENT_GREEN, BRAND_ACCENT_TILE, BRAND_GRID_TILES } from "./BrandMark";

interface PaperclipLockupProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  decorative?: boolean;
  title?: string;
}

/**
 * Brand lockup rendered on sign-in chrome.
 * Uses the transparent 9-square geometric mark (8 `currentColor` tiles + `#b5db24` top-right tile).
 */
export function PaperclipLockup({
  decorative = false,
  title = "Paperclip",
  className,
  ...rest
}: PaperclipLockupProps) {
  return (
    <svg
      {...rest}
      className={className}
      viewBox="0 0 100 100"
      fill="none"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      {BRAND_GRID_TILES.map((tile, index) => (
        <rect
          key={index}
          x={tile.x}
          y={tile.y}
          width={tile.width}
          height={tile.height}
          fill="currentColor"
        />
      ))}
      <rect
        x={BRAND_ACCENT_TILE.x}
        y={BRAND_ACCENT_TILE.y}
        width={BRAND_ACCENT_TILE.width}
        height={BRAND_ACCENT_TILE.height}
        fill={BRAND_ACCENT_GREEN}
      />
    </svg>
  );
}
