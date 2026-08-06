import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const isNativeMobile = mock(() => true);
mock.module("@/runtime/platform-detection", () => ({ isNativeMobile }));

const {
  navigateWithPageTransition,
  pageTransitionsEnabled,
  resetPageTransitionState,
} = await import("@/lib/page-transition");

/**
 * The real `startViewTransition` is non-optional in `lib.dom`, so stubbing and
 * unstubbing it goes through an index signature rather than the typed member.
 */
const documentRecord = document as unknown as Record<string, unknown>;

function installViewTransitionApi(): void {
  documentRecord.startViewTransition = () => ({});
}

function removeViewTransitionApi(): void {
  delete documentRecord.startViewTransition;
}

function directionAttribute(): string | null {
  return document.documentElement.getAttribute("data-page-transition");
}

describe("navigateWithPageTransition", () => {
  let navigate: ReturnType<typeof mock>;

  beforeEach(() => {
    navigate = mock(() => {});
    isNativeMobile.mockReturnValue(true);
    installViewTransitionApi();
    resetPageTransitionState();
  });

  afterEach(() => {
    removeViewTransitionApi();
    resetPageTransitionState();
  });

  test("asks for a view transition and records the direction", () => {
    navigateWithPageTransition(navigate as never, "/assistant/settings", "pop");
    expect(navigate).toHaveBeenCalledWith("/assistant/settings", {
      viewTransition: true,
    });
    expect(directionAttribute()).toBe("pop");
  });

  test("carries the caller's own navigate options through", () => {
    navigateWithPageTransition(navigate as never, "/a", "push", {
      replace: true,
    });
    expect(navigate).toHaveBeenCalledWith("/a", {
      replace: true,
      viewTransition: true,
    });
  });

  test("navigates plainly off the native mobile shells", () => {
    isNativeMobile.mockReturnValue(false);
    navigateWithPageTransition(navigate as never, "/a", "push");
    expect(navigate).toHaveBeenCalledWith("/a", undefined);
    expect(directionAttribute()).toBeNull();
  });

  test("navigates plainly when the engine has no View Transitions API", () => {
    removeViewTransitionApi();
    navigateWithPageTransition(navigate as never, "/a", "pop");
    expect(navigate).toHaveBeenCalledWith("/a", undefined);
    expect(directionAttribute()).toBeNull();
  });

  test("the latest direction wins when navigations land back to back", () => {
    navigateWithPageTransition(navigate as never, "/a", "push");
    navigateWithPageTransition(navigate as never, "/b", "pop");
    expect(directionAttribute()).toBe("pop");
  });
});

describe("pageTransitionsEnabled", () => {
  afterEach(() => {
    removeViewTransitionApi();
    isNativeMobile.mockReturnValue(true);
  });

  test("requires both a mobile shell and the API", () => {
    installViewTransitionApi();
    isNativeMobile.mockReturnValue(true);
    expect(pageTransitionsEnabled()).toBe(true);

    isNativeMobile.mockReturnValue(false);
    expect(pageTransitionsEnabled()).toBe(false);

    isNativeMobile.mockReturnValue(true);
    removeViewTransitionApi();
    expect(pageTransitionsEnabled()).toBe(false);
  });
});
