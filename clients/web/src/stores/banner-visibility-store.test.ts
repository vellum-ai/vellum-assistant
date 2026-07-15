import { describe, it, expect, beforeEach } from "bun:test";

import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";

beforeEach(() => {
  useBannerVisibilityStore.setState({ bannerVisible: false });
});

describe("useBannerVisibilityStore", () => {
  it("initial state is false", () => {
    expect(useBannerVisibilityStore.getState().bannerVisible).toBe(false);
  });

  it("setBannerVisible(true) flips the flag", () => {
    useBannerVisibilityStore.getState().setBannerVisible(true);
    expect(useBannerVisibilityStore.getState().bannerVisible).toBe(true);
  });

  it("setBannerVisible(false) flips back", () => {
    useBannerVisibilityStore.getState().setBannerVisible(true);
    useBannerVisibilityStore.getState().setBannerVisible(false);
    expect(useBannerVisibilityStore.getState().bannerVisible).toBe(false);
  });

  it("setting the same value is a no-op (no state churn)", () => {
    let notifications = 0;
    const unsubscribe = useBannerVisibilityStore.subscribe(() => {
      notifications++;
    });
    useBannerVisibilityStore.getState().setBannerVisible(false);
    expect(notifications).toBe(0);
    useBannerVisibilityStore.getState().setBannerVisible(true);
    useBannerVisibilityStore.getState().setBannerVisible(true);
    expect(notifications).toBe(1);
    unsubscribe();
  });
});
