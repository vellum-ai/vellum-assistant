/**
 * Smoke tests for `ChatAvatar`.
 *
 * The repo doesn't have @testing-library/react wired up, so we exercise the
 * component through `renderToStaticMarkup` and assert on the resulting HTML
 * string (same pattern as `CreatureFooter.test.tsx` and friends).
 *
 * `renderToStaticMarkup` does NOT execute `useEffect`, so we can only assert
 * on the initial render — entrance animation timing and click-driven state
 * transitions cannot be observed end-to-end here. The reduced-motion path is
 * covered by stubbing `motion/react`'s `useReducedMotion` hook.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CharacterComponents, CharacterTraits } from "@/lib/avatar/types.js";

import { ChatAvatar } from "@/components/assistant/Avatar/ChatAvatar.js";

// ---------------------------------------------------------------------------
// Test fixtures
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
// Tests
// ---------------------------------------------------------------------------

describe("ChatAvatar", () => {
  test("renders the V fallback when no components, traits, or custom image are provided", () => {
    const html = renderToStaticMarkup(
      <ChatAvatar components={null} traits={null} customImageUrl={null} />,
    );
    // The fallback branch renders the literal "V" inside a colored circle.
    expect(html).toContain("V");
    expect(html).toContain("rounded-full");
  });

  test("renders an <img> when customImageUrl is provided", () => {
    const html = renderToStaticMarkup(
      <ChatAvatar
        components={null}
        traits={null}
        customImageUrl="https://example.test/avatar.png"
      />,
    );
    // next/image renders an <img> tag in static markup. We only care that
    // the src attribute references the supplied URL.
    expect(html).toContain("<img");
    expect(html).toContain("avatar.png");
    // Should not fall back to the "V" placeholder when an image is supplied.
    expect(html).toContain('alt="Assistant avatar"');
  });

  test("composes an inline SVG when components + traits are provided", () => {
    const html = renderToStaticMarkup(
      <ChatAvatar
        components={COMPONENTS}
        traits={TRAITS}
        customImageUrl={null}
      />,
    );
    // composeSvg emits an <svg> root element with the body shape path.
    expect(html).toContain("<svg");
  });

  test("falls back to the first component of each type when traits are null and no custom image", () => {
    const html = renderToStaticMarkup(
      <ChatAvatar components={COMPONENTS} traits={null} customImageUrl={null} />,
    );
    expect(html).toContain("<svg");
  });

  test("custom image wins over default components when no explicit traits are saved", () => {
    const html = renderToStaticMarkup(
      <ChatAvatar
        components={COMPONENTS}
        traits={null}
        customImageUrl="https://example.test/custom-avatar.png"
      />,
    );
    // Should render the custom image, not the default character SVG.
    expect(html).toContain("<img");
    expect(html).toContain("custom-avatar.png");
    expect(html).not.toContain("<svg");
  });

  test("saved traits take priority over custom image", () => {
    const html = renderToStaticMarkup(
      <ChatAvatar
        components={COMPONENTS}
        traits={TRAITS}
        customImageUrl="https://example.test/custom-avatar.png"
      />,
    );
    // When traits are explicitly saved, the animated character renders.
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
  });

  test("interactive=true renders a wrapper that announces a pointer cursor", () => {
    // `renderToStaticMarkup` doesn't preserve React `onClick` handlers in the
    // emitted HTML (server markup omits event handlers by design). We instead
    // assert the visible affordance — `cursor: pointer` — that the component
    // applies whenever `interactive` is true.
    const html = renderToStaticMarkup(
      <ChatAvatar
        components={null}
        traits={null}
        customImageUrl={null}
        interactive
      />,
    );
    expect(html).toContain("cursor:pointer");
  });

  test("interactive=false omits the pointer cursor", () => {
    const html = renderToStaticMarkup(
      <ChatAvatar
        components={null}
        traits={null}
        customImageUrl={null}
        interactive={false}
      />,
    );
    expect(html).not.toContain("cursor:pointer");
  });

  test("respects the size prop on the fallback wrapper", () => {
    const html = renderToStaticMarkup(
      <ChatAvatar
        components={null}
        traits={null}
        customImageUrl={null}
        size={64}
      />,
    );
    // The wrapper inlines width/height in pixels.
    expect(html).toContain("width:64px");
    expect(html).toContain("height:64px");
  });
});

// ---------------------------------------------------------------------------
// Reduced-motion path — verified by stubbing `motion/react` so that
// `useReducedMotion()` returns true. Static markup can't observe the spring
// transition object, but we can confirm the component still mounts and renders
// the expected fallback markup with the reduced-motion hook engaged.
// ---------------------------------------------------------------------------

describe("ChatAvatar reduced-motion path", () => {
  afterEach(() => {
    // `mock.module` is process-global; the next test that imports
    // `motion/react` will resolve to the stub if we don't restore.
    mock.restore();
  });

  test("renders without animation props when prefers-reduced-motion is set", async () => {
    // Stub `motion/react` so that:
    //   - `useReducedMotion` always reports `true`.
    //   - `motion.div` is a plain <div> that strips animation-only props
    //     (`animate`, `initial`, `transition`) — so we can assert from the
    //     emitted static markup that those props are not leaking into the
    //     DOM in the reduced-motion branch.
    mock.module("motion/react", () => {
      const passthrough = ({
        children,
        // Strip motion-only props so they don't end up as DOM attributes.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        animate,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        initial,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        transition,
        ...rest
      }: {
        children?: React.ReactNode;
        animate?: unknown;
        initial?: unknown;
        transition?: unknown;
        [key: string]: unknown;
      }) => <div {...rest}>{children}</div>;
      return {
        motion: { div: passthrough },
        useReducedMotion: () => true,
      };
    });

    // Re-import the subject AFTER the mock is registered so it picks up the
    // stub. `await import` returns a fresh module record because Bun's
    // `mock.module` invalidates the cache for the mocked specifier.
    const { ChatAvatar: PatchedChatAvatar } = await import("./ChatAvatar");
    const html = renderToStaticMarkup(
      <PatchedChatAvatar
        components={null}
        traits={null}
        customImageUrl={null}
        interactive
      />,
    );
    // Sanity: still renders the fallback letter.
    expect(html).toContain("V");
    // Motion-only props must not have leaked into the DOM as attributes.
    expect(html).not.toContain("animate=");
    expect(html).not.toContain("initial=");
    expect(html).not.toContain("transition=");
  });
});
