import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "bun:test";

import {
  cssTransitionFor,
  DEFAULT_SHELL_BACKGROUND,
  resolveShellBackground,
  resolveShellTransition,
  usePageSurfaceStore,
  usePublishPageSurface,
} from "@/stores/page-surface-store";

afterEach(() => {
  cleanup();
  usePageSurfaceStore.getState().setSurface(null);
});

describe("cssTransitionFor", () => {
  it("spells Motion's easing the CSS way", () => {
    expect(cssTransitionFor({ duration: 1, ease: "easeInOut" })).toBe(
      "1s ease-in-out",
    );
  });

  it("defaults to Motion's own default tween easing", () => {
    // Omitting `ease` means `easeOut` in Motion, so it has to here as well or
    // the strips would run a different curve than the canvas.
    expect(cssTransitionFor({ duration: 0.6 })).toBe("0.6s ease-out");
  });

  it("carries a delay when there is one, and omits it when there is not", () => {
    expect(cssTransitionFor({ duration: 0.6, delay: 0.35 })).toBe(
      "0.6s ease-out 0.35s",
    );
    expect(cssTransitionFor({ duration: 0.6, delay: 0 })).toBe("0.6s ease-out");
  });
});

describe("resolveShellTransition", () => {
  it("scopes a published transition to the color", () => {
    expect(resolveShellTransition("1s ease-in-out", true)).toBe(
      "background-color 1s ease-in-out",
    );
  });

  it("leaves the property off when nothing is animating", () => {
    expect(resolveShellTransition(null, true)).toBeUndefined();
  });

  it("keeps the property off outside native mobile, where nothing is painted", () => {
    expect(resolveShellTransition("1s ease-in-out", false)).toBeUndefined();
  });
});

describe("resolveShellBackground", () => {
  it("paints a published surface on the native mobile shells", () => {
    expect(resolveShellBackground("var(--surface-overlay)", true)).toBe(
      "var(--surface-overlay)",
    );
  });

  it("keeps the neutral canvas off native mobile, whatever a page publishes", () => {
    expect(resolveShellBackground("var(--surface-overlay)", false)).toBe(
      DEFAULT_SHELL_BACKGROUND,
    );
  });

  it("falls back to the neutral canvas when no page publishes one", () => {
    expect(resolveShellBackground(null, true)).toBe(DEFAULT_SHELL_BACKGROUND);
    expect(resolveShellBackground(null, false)).toBe(DEFAULT_SHELL_BACKGROUND);
  });
});

describe("usePageSurfaceStore", () => {
  it("publishes and clears a surface", () => {
    usePageSurfaceStore.getState().setSurface("var(--surface-overlay)");
    expect(usePageSurfaceStore.getState().surface).toBe(
      "var(--surface-overlay)",
    );

    usePageSurfaceStore.getState().setSurface(null);
    expect(usePageSurfaceStore.getState().surface).toBeNull();
  });

  it("no-ops when the surface is unchanged", () => {
    usePageSurfaceStore.getState().setSurface("var(--surface-overlay)");
    const before = usePageSurfaceStore.getState();

    usePageSurfaceStore.getState().setSurface("var(--surface-overlay)");

    expect(usePageSurfaceStore.getState()).toBe(before);
  });
});

function Publisher({
  surface,
  transition,
}: {
  surface: string | null;
  transition?: string;
}) {
  usePublishPageSurface(surface, transition ?? null);
  return null;
}

describe("usePublishPageSurface", () => {
  it("publishes while mounted and clears on unmount", () => {
    const { unmount } = render(<Publisher surface="#E5C100" />);
    expect(usePageSurfaceStore.getState().surface).toBe("#E5C100");

    unmount();
    expect(usePageSurfaceStore.getState().surface).toBeNull();
  });

  it("lands the first surface outright, whatever timing is offered", () => {
    // A page takes its canvas color on arrival rather than fading into it, so
    // the strips must not fade up from whatever the last page left behind.
    render(<Publisher surface="#E5C100" transition="0.6s ease-out 0.35s" />);

    expect(usePageSurfaceStore.getState().surface).toBe("#E5C100");
    expect(usePageSurfaceStore.getState().transition).toBeNull();
  });

  it("carries the page's timing once the color changes", () => {
    const { rerender } = render(<Publisher surface="#17191C" />);

    rerender(<Publisher surface="#E5C100" transition="1s ease-in-out" />);

    expect(usePageSurfaceStore.getState().transition).toBe("1s ease-in-out");
  });

  it("clears the timing along with the surface", () => {
    const { rerender, unmount } = render(<Publisher surface="#17191C" />);
    rerender(<Publisher surface="#E5C100" transition="1s ease-in-out" />);

    unmount();

    expect(usePageSurfaceStore.getState().surface).toBeNull();
    expect(usePageSurfaceStore.getState().transition).toBeNull();
  });

  it("changes color in one write, with no clear in between", () => {
    const steps: (string | null)[] = [];
    const stop = usePageSurfaceStore.subscribe((state) =>
      steps.push(state.surface),
    );

    const { rerender, unmount } = render(<Publisher surface="#17191C" />);
    rerender(<Publisher surface="#E5C100" transition="1s ease-in-out" />);
    stop();

    expect(steps).toEqual(["#17191C", "#E5C100"]);
    expect(usePageSurfaceStore.getState().transition).toBe("1s ease-in-out");
    unmount();
  });

  it("opts out without touching what another publisher set", () => {
    usePageSurfaceStore.getState().setSurface("#E5C100");

    const { unmount } = render(<Publisher surface={null} />);
    expect(usePageSurfaceStore.getState().surface).toBe("#E5C100");

    unmount();
    expect(usePageSurfaceStore.getState().surface).toBe("#E5C100");
  });

  it("leaves an incoming screen's surface alone when the outgoing one unmounts", () => {
    const { unmount } = render(<Publisher surface="#E5C100" />);
    render(<Publisher surface="#17191C" />);

    unmount();

    expect(usePageSurfaceStore.getState().surface).toBe("#17191C");
  });

  it("does the same when the two screens share a color", () => {
    // Ownership is identity, not color: by value these two publishers are
    // indistinguishable, and the outgoing one would clear a surface the
    // incoming one is still showing.
    const { unmount } = render(<Publisher surface="#E5C100" />);
    render(<Publisher surface="#E5C100" />);

    unmount();

    expect(usePageSurfaceStore.getState().surface).toBe("#E5C100");
  });
});
