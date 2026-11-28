// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BRAND_ACCENT_GREEN, BrandMark } from "./BrandMark";
import { PaperclipLockup } from "./PaperclipLockup";
import { AnimatedPaperclipIcon } from "./AnimatedPaperclipIcon";

describe("BrandMark", () => {
  it("renders the 8 currentColor grid tiles plus the lime-green top-right tile", () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html.match(/fill="currentColor"/g)).toHaveLength(8);
    expect(html).toContain(`fill="${BRAND_ACCENT_GREEN}"`);
    expect(html).not.toContain("m16 6-8.414");
  });

  it("is used by PaperclipLockup and AnimatedPaperclipIcon", () => {
    const lockup = renderToStaticMarkup(<PaperclipLockup />);
    expect(lockup.match(/fill="currentColor"/g)).toHaveLength(8);
    expect(lockup).toContain(`fill="${BRAND_ACCENT_GREEN}"`);

    const animated = renderToStaticMarkup(<AnimatedPaperclipIcon />);
    expect(animated.match(/fill="currentColor"/g)).toHaveLength(8);
    expect(animated).toContain(`fill="${BRAND_ACCENT_GREEN}"`);
  });
});
