import { describe, it, expect, beforeEach } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { useLowBalanceBannerStore } from "@/stores/low-balance-banner-store";

beforeEach(() => {
  useLowBalanceBannerStore.setState({ dismissed: false });
});

describe("useLowBalanceBannerStore", () => {
  it("starts undismissed", () => {
    expect(useLowBalanceBannerStore.getState().dismissed).toBe(false);
  });

  it("dismiss() latches dismissed on for the session", () => {
    useLowBalanceBannerStore.getState().dismiss();
    expect(useLowBalanceBannerStore.getState().dismissed).toBe(true);

    // Idempotent: repeated dismissals keep the latch set.
    useLowBalanceBannerStore.getState().dismiss();
    expect(useLowBalanceBannerStore.getState().dismissed).toBe(true);
  });

  it("exposes a reactive dismissed selector", () => {
    const { result } = renderHook(useLowBalanceBannerStore.use.dismissed);
    expect(result.current).toBe(false);

    act(() => useLowBalanceBannerStore.getState().dismiss());
    expect(result.current).toBe(true);
  });
});
