import { describe, it, expect, beforeEach } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import {
  useBannerVisibilityStore,
  useBannerVisible,
} from "@/stores/banner-visibility-store";

const visible = () =>
  useBannerVisibilityStore.getState().visibleBannerCount > 0;

beforeEach(() => {
  useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
});

describe("useBannerVisibilityStore", () => {
  it("starts with no visible banners", () => {
    expect(useBannerVisibilityStore.getState().visibleBannerCount).toBe(0);
    expect(visible()).toBe(false);
  });

  it("register/unregister round-trips the visibility", () => {
    useBannerVisibilityStore.getState().registerVisibleBanner();
    expect(visible()).toBe(true);
    useBannerVisibilityStore.getState().unregisterVisibleBanner();
    expect(visible()).toBe(false);
  });

  it("stays visible until every registrant unregisters (concurrent instances)", () => {
    const { registerVisibleBanner, unregisterVisibleBanner } =
      useBannerVisibilityStore.getState();
    registerVisibleBanner();
    registerVisibleBanner();
    expect(useBannerVisibilityStore.getState().visibleBannerCount).toBe(2);

    unregisterVisibleBanner();
    expect(visible()).toBe(true);
    unregisterVisibleBanner();
    expect(visible()).toBe(false);
  });

  it("unregister at zero clamps — the count never goes negative", () => {
    useBannerVisibilityStore.getState().unregisterVisibleBanner();
    expect(useBannerVisibilityStore.getState().visibleBannerCount).toBe(0);

    // A later register must still flip visibility on.
    useBannerVisibilityStore.getState().registerVisibleBanner();
    expect(visible()).toBe(true);
  });
});

describe("useBannerVisible", () => {
  it("reactively derives count > 0", () => {
    const { result } = renderHook(useBannerVisible);
    expect(result.current).toBe(false);

    act(() => useBannerVisibilityStore.getState().registerVisibleBanner());
    expect(result.current).toBe(true);

    act(() => useBannerVisibilityStore.getState().unregisterVisibleBanner());
    expect(result.current).toBe(false);
  });
});
