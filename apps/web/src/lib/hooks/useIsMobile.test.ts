/**
 * Tests for `useIsMobile`.
 *
 * Coverage:
 *   1. SSR snapshot path — `renderToStaticMarkup` exercises React's server
 *      renderer, which calls `getServerSnapshot()` and must return `false`
 *      regardless of any matchMedia mock state (the server cannot know the
 *      viewport).
 *   2. Client snapshot path — RTL `render()` mounts the hook in happy-dom;
 *      the mocked `window.matchMedia` returns the live `matches` value.
 *   3. Subscribe path — flipping `matches` and dispatching a `change` event
 *      on the mocked `MediaQueryList` triggers a re-render with the new
 *      value (the contract `useSyncExternalStore` relies on).
 *   4. The exported `MOBILE_MEDIA_QUERY` constant is exactly the previous
 *      AssistantShell value.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, render } from "@testing-library/react";

import { MOBILE_MEDIA_QUERY, useIsMobile } from "@/lib/hooks/useIsMobile.js";

// ---------------------------------------------------------------------------
// matchMedia mock — minimal `MediaQueryList`-like stub. Each `matchMedia()`
// call returns a fresh object that reads from the shared `matchesRef` so
// tests can flip `matches` and have all subscribers see the new value.
// ---------------------------------------------------------------------------

interface ListenerEntry {
  list: MockMediaQueryList;
  listener: () => void;
}

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: (type: "change", listener: () => void) => void;
  removeEventListener: (type: "change", listener: () => void) => void;
}

const matchesRef = { value: false };
let entries: ListenerEntry[] = [];
let originalMatchMedia: typeof window.matchMedia | undefined;

function makeMql(query: string): MockMediaQueryList {
  const mql: MockMediaQueryList = {
    media: query,
    get matches() {
      return matchesRef.value;
    },
    addEventListener: (_type, listener) => {
      entries.push({ list: mql, listener });
    },
    removeEventListener: (_type, listener) => {
      entries = entries.filter((e) => e.listener !== listener);
    },
  };
  return mql;
}

function dispatchChange(): void {
  entries.forEach((e) => e.listener());
}

beforeEach(() => {
  matchesRef.value = false;
  entries = [];
  originalMatchMedia = window.matchMedia;
  // Cast through unknown to satisfy the dom MediaQueryList shape — our mock
  // intentionally only covers the surface useIsMobile actually touches.
  window.matchMedia = ((query: string) =>
    makeMql(query)) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia;
  }
  entries = [];
});

function HookConsumer() {
  const isMobile = useIsMobile();
  return createElement("span", null, String(isMobile));
}

describe("MOBILE_MEDIA_QUERY", () => {
  test("matches the historical AssistantShell value", () => {
    // Pinned to the literal string so future bumps require an explicit
    // breakpoint conversation — `SidebarPageLayout`'s `md:` (768px),
    // `AssistantShell`'s rail/drawer swap, and the BottomSheet primitive
    // all rely on this exact threshold.
    expect(MOBILE_MEDIA_QUERY).toBe("(max-width: 767px)");
  });
});

describe("useIsMobile", () => {
  test("returns false on the server (SSR snapshot path)", () => {
    // React's server renderer calls `getServerSnapshot()` — which always
    // returns false so the first paint never assumes a viewport that the
    // server cannot know. We force the mock into the `true` state to prove
    // the SSR path ignores it.
    matchesRef.value = true;
    const html = renderToStaticMarkup(createElement(HookConsumer));
    expect(html).toBe("<span>false</span>");
  });

  test("returns the live matchMedia.matches value on the client", () => {
    matchesRef.value = true;
    const { container } = render(createElement(HookConsumer));
    expect(container.textContent).toBe("true");
  });

  test("re-renders when the matchMedia change event fires", () => {
    matchesRef.value = false;
    const { container } = render(createElement(HookConsumer));
    expect(container.textContent).toBe("false");

    // Simulate the viewport crossing into mobile.
    act(() => {
      matchesRef.value = true;
      dispatchChange();
    });
    expect(container.textContent).toBe("true");

    // And back out.
    act(() => {
      matchesRef.value = false;
      dispatchChange();
    });
    expect(container.textContent).toBe("false");
  });
});
