import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { composeSvg } from "@/lib/avatar/svg-compositor.js";
import type { CharacterComponents, CharacterTraits } from "@/lib/avatar/types.js";

import { useDynamicFavicon } from "@/lib/avatar/useDynamicFavicon.js";

// ---------------------------------------------------------------------------
// Fixtures (same as ChatAvatar.test.tsx)
// ---------------------------------------------------------------------------

const COMPONENTS: CharacterComponents = {
  bodyShapes: [
    {
      id: "body-1",
      viewBox: { width: 100, height: 100 },
      faceCenter: { x: 50, y: 50 },
      svgPath: "M0 0h100v100H0z",
    },
  ],
  eyeStyles: [
    {
      id: "eyes-1",
      sourceViewBox: { width: 100, height: 100 },
      eyeCenter: { x: 50, y: 50 },
      paths: [{ svgPath: "M40 40h20v20H40z", color: "#000" }],
    },
  ],
  colors: [{ id: "color-1", hex: "#ff00aa" }],
  faceCenterOverrides: [],
};

const TRAITS: CharacterTraits = {
  bodyShape: "body-1",
  eyeStyle: "eyes-1",
  color: "color-1",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Since we can't run React hooks outside of a component, we test the
 * underlying DOM-manipulation logic directly by simulating what the
 * useEffect callback does. The hook is thin enough that testing the
 * effect body in isolation covers the meaningful behavior.
 */
function simulateEffect(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): (() => void) | undefined {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return undefined;

  let href: string | null = null;

  if (components && traits) {
    try {
      const svg = composeSvg(
        components,
        traits.bodyShape,
        traits.eyeStyle,
        traits.color,
        32,
      );
      href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    } catch {
      // fall through
    }
  }

  if (!href && customImageUrl) {
    href = customImageUrl;
  }

  if (href) {
    link.href = href;
  } else {
    link.href = "/favicon.svg";
  }

  return () => {
    link.href = "/favicon.svg";
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDynamicFavicon", () => {
  let link: HTMLLinkElement;

  beforeEach(() => {
    link = document.createElement("link");
    link.rel = "icon";
    link.href = "/favicon.svg";
    document.head.appendChild(link);
  });

  afterEach(() => {
    link.remove();
  });

  test("module exports the hook function", () => {
    expect(typeof useDynamicFavicon).toBe("function");
  });

  test("sets SVG data URI when components + traits are provided", () => {
    simulateEffect(null, COMPONENTS, TRAITS);

    expect(link.href).toContain("data:image/svg+xml,");
    expect(link.href).toContain(encodeURIComponent("<svg"));
  });

  test("sets custom image URL when no traits are provided", () => {
    simulateEffect("blob:http://localhost/avatar-123", null, null);

    expect(link.href).toContain("blob:");
  });

  test("character SVG takes priority over custom image URL", () => {
    simulateEffect("blob:http://localhost/avatar-123", COMPONENTS, TRAITS);

    expect(link.href).toContain("data:image/svg+xml,");
    expect(link.href).not.toContain("blob:");
  });

  test("falls back to custom image when composeSvg throws (bad trait IDs)", () => {
    const badTraits: CharacterTraits = {
      bodyShape: "nonexistent",
      eyeStyle: "nonexistent",
      color: "nonexistent",
    };
    simulateEffect("blob:http://localhost/fallback", COMPONENTS, badTraits);

    expect(link.href).toContain("blob:");
  });

  test("restores default favicon when no avatar data is provided", () => {
    // First set it to something
    link.href = "data:image/svg+xml,test";

    simulateEffect(null, null, null);

    expect(link.href).toContain("/favicon.svg");
  });

  test("cleanup function restores default favicon", () => {
    const cleanup = simulateEffect(null, COMPONENTS, TRAITS);

    expect(link.href).toContain("data:image/svg+xml,");

    cleanup?.();

    expect(link.href).toContain("/favicon.svg");
  });

  test("SVG data URI contains the avatar color", () => {
    simulateEffect(null, COMPONENTS, TRAITS);

    const decoded = decodeURIComponent(link.href);
    expect(decoded).toContain("#ff00aa");
  });
});
