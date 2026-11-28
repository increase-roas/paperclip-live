import type { SVGProps } from "react";

export const BRAND_ACCENT_GREEN = "#b5db24";

export const BRAND_GRID_TILES = [
  { x: 9.0, y: 23.2, width: 21.0, height: 21.0 },
  { x: 33.9, y: 23.2, width: 21.0, height: 21.0 },
  { x: 9.0, y: 48.1, width: 21.0, height: 21.0 },
  { x: 33.9, y: 48.1, width: 21.0, height: 21.0 },
  { x: 58.8, y: 48.1, width: 21.0, height: 21.0 },
  { x: 9.0, y: 73.0, width: 21.0, height: 21.0 },
  { x: 33.9, y: 73.0, width: 21.0, height: 21.0 },
  { x: 58.8, y: 73.0, width: 21.0, height: 21.0 },
] as const;

export const BRAND_ACCENT_TILE = {
  x: 58.8,
  y: 6.0,
  width: 32.3,
  height: 34.3,
} as const;

/**
 * Primary geometric brand mark (transparent background):
 * 8 theme-adaptive `currentColor` grid squares + 1 signature `#b5db24` top-right tile.
 */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      fill="none"
      focusable="false"
      {...props}
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
