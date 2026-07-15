/**
 * Tests for `useTipCard` — the orchestration hook behind the sidebar tip
 * card. Gates (flag, preference, banner exclusivity, new-user grace) are
 * driven through the real stores/storage; only telemetry is mocked so
 * emissions can be asserted without the onboarding funnel pipeline.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  createElement,
  Fragment,
  useLayoutEffect,
  type ReactNode,
} from "react";

const emitTipEvent = mock(() => {});
mock.module("@/utils/tips-telemetry", () => ({ emitTipEvent }));

const { useTipCard, TIPS_MIN_ACCOUNT_AGE_MS } = await import(
  "@/hooks/use-tip-card"
);
const { useAssistantFeatureFlagStore } = await import(
  "@/stores/assistant-feature-flag-store"
);
const { useBannerVisibilityStore } = await import(
  "@/stores/banner-visibility-store"
);
const { useClientFeatureFlagStore } = await import(
  "@/stores/client-feature-flag-store"
);
const { TIPS_CATALOG } = await import("@/utils/tips-catalog");
const { TIP_ROTATION_INTERVAL_MS } = await import("@/utils/tips-selection");
const {
  recordTipDismissed,
  tipRecordsStorage,
  tipsDemoCyclerStorage,
  tipsEnabledStorage,
  tipsFirstSeenAtStorage,
} = await import("@/utils/tips-storage");

const FIRST_TIP_ID = TIPS_CATALOG[0].id;
// Successor on web once the first tip is dismissed: next tip that passes
// gates in this environment (no Electron, no flags, no plugins surface).
const SECOND_UNGATED_TIP_ID = TIPS_CATALOG.filter((tip) => !tip.gates)[1].id;

function setFlag(value: "on" | "off") {
  useClientFeatureFlagStore.getState().setStringFlags({ proactiveTips: value });
}

/** Stamp first-seen far enough in the past that the new-user grace has run. */
function stampAgedFirstSeen() {
  tipsFirstSeenAtStorage.save(Date.now() - TIPS_MIN_ACCOUNT_AGE_MS - 60_000);
}

/** Flag on + aged first-seen — tips enabled is the storage default (true). */
function openAllGates() {
  setFlag("on");
  stampAgedFirstSeen();
}

beforeEach(() => {
  localStorage.clear();
  setFlag("off");
  useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
  useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
  emitTipEvent.mockClear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useTipCard gates", () => {
  test("returns null while the proactive-tips flag is off", () => {
    stampAgedFirstSeen();

    const { result } = renderHook(() => useTipCard());

    expect(result.current.tip).toBeNull();
    expect(emitTipEvent).not.toHaveBeenCalled();
  });

  test("returns null when the user disabled tips", () => {
    openAllGates();
    tipsEnabledStorage.save(false);

    const { result } = renderHook(() => useTipCard());

    expect(result.current.tip).toBeNull();
    expect(emitTipEvent).not.toHaveBeenCalled();
  });

  test("hides while a nudge banner is visible and reappears when it unregisters", () => {
    openAllGates();
    act(() => {
      useBannerVisibilityStore.getState().registerVisibleBanner();
    });

    const { result } = renderHook(() => useTipCard());
    expect(result.current.tip).toBeNull();

    act(() => {
      useBannerVisibilityStore.getState().unregisterVisibleBanner();
    });
    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);
  });

  test("returns null during the new-user grace and stamps first-seen", () => {
    setFlag("on");

    const { result } = renderHook(() => useTipCard());

    expect(result.current.tip).toBeNull();
    expect(tipsFirstSeenAtStorage.load()).toBeGreaterThan(0);
    expect(emitTipEvent).not.toHaveBeenCalled();
  });
});

describe("useTipCard selection and impressions", () => {
  test("selects the first catalog tip and records the impression", () => {
    openAllGates();

    const { result } = renderHook(() => useTipCard());

    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);
    const record = tipRecordsStorage.load()[FIRST_TIP_ID];
    expect(record?.lastShownAt).toBeGreaterThan(0);
    expect(record?.shownCount).toBe(1);
    expect(emitTipEvent).toHaveBeenCalledTimes(1);
    expect(emitTipEvent).toHaveBeenCalledWith(FIRST_TIP_ID, "impression", "on");
  });

  test("emits the impression at most once per rotation window across remounts", () => {
    openAllGates();

    const first = renderHook(() => useTipCard());
    expect(emitTipEvent).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(() => useTipCard());
    expect(second.result.current.tip?.id).toBe(FIRST_TIP_ID);
    expect(emitTipEvent).toHaveBeenCalledTimes(1);
    expect(tipRecordsStorage.load()[FIRST_TIP_ID]?.shownCount).toBe(1);
  });

  test("skips the impression when a banner registers via layout effect in the same commit", () => {
    stampAgedFirstSeen();

    // Mirrors ChatBody: a sibling whose layout effect registers the banner in
    // the same commit whose render selected a tip — that render still saw
    // bannerVisible === false, so only the effect-time store read can catch it.
    function BannerRegistrar() {
      const bannerEligible =
        useClientFeatureFlagStore().stringFlags.proactiveTips === "on";
      useLayoutEffect(() => {
        if (!bannerEligible) {
          return;
        }
        const { registerVisibleBanner, unregisterVisibleBanner } =
          useBannerVisibilityStore.getState();
        registerVisibleBanner();
        return unregisterVisibleBanner;
      }, [bannerEligible]);
      return null;
    }

    const { result } = renderHook(() => useTipCard(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(Fragment, null, createElement(BannerRegistrar), children),
    });
    expect(result.current.tip).toBeNull();

    // One batch: the flag flip makes the hook select a tip while the banner
    // registers during the same commit's layout phase.
    act(() => {
      setFlag("on");
    });

    expect(result.current.tip).toBeNull();
    expect(tipRecordsStorage.load()[FIRST_TIP_ID]).toBeUndefined();
    expect(emitTipEvent).not.toHaveBeenCalled();
  });

  test("excludes gated tips whose requirements fail and includes them when met", () => {
    openAllGates();
    // Exhaust every ungated tip; on web the electron/flag/plugins-gated
    // remainder must all be filtered out, leaving nothing to show.
    const now = Date.now();
    for (const tip of TIPS_CATALOG.filter((entry) => !entry.gates)) {
      recordTipDismissed(tip.id, now);
    }

    const { result } = renderHook(() => useTipCard());
    expect(result.current.tip).toBeNull();

    // Turning the gating assistant flag on makes the voice tip eligible.
    act(() => {
      useAssistantFeatureFlagStore.getState().setFlags({ voiceMode: true });
    });
    expect(result.current.tip?.id).toBe("voice-mode");
  });
});

describe("useTipCard rotation", () => {
  test("shows a dismissed tip's successor when the window elapses while mounted", async () => {
    openAllGates();
    const { result } = renderHook(() => useTipCard());
    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);

    act(() => {
      result.current.onDismiss();
    });
    expect(result.current.tip).toBeNull();

    // Rewind the stamped record so the rotation boundary (lastShownAt +
    // window) lands ~40ms of real time from now; the hook reschedules its
    // boundary timer off the records change. Bun's setSystemTime doesn't
    // advance setTimeout, so the test rides a short real timer instead.
    act(() => {
      const record = tipRecordsStorage.load()[FIRST_TIP_ID];
      tipRecordsStorage.save({
        [FIRST_TIP_ID]: {
          ...record,
          shownCount: record?.shownCount ?? 1,
          lastShownAt: Date.now() - TIP_ROTATION_INTERVAL_MS + 40,
        },
      });
    });
    // Still within the window: the slot stays blank until the boundary.
    expect(result.current.tip).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    // No remount: the boundary timer refreshed the clock and the successor
    // took the slot (and stamped its own impression).
    expect(result.current.tip?.id).toBe(SECOND_UNGATED_TIP_ID);
    expect(
      tipRecordsStorage.load()[SECOND_UNGATED_TIP_ID]?.lastShownAt,
    ).toBeGreaterThan(0);
  });
});

describe("useTipCard actions", () => {
  test("dismiss stamps the record, emits, and blanks the slot for the window", () => {
    openAllGates();
    const { result } = renderHook(() => useTipCard());
    emitTipEvent.mockClear();

    act(() => {
      result.current.onDismiss();
    });

    expect(result.current.tip).toBeNull();
    expect(tipRecordsStorage.load()[FIRST_TIP_ID]?.dismissedAt).toBeGreaterThan(
      0,
    );
    expect(emitTipEvent).toHaveBeenCalledTimes(1);
    expect(emitTipEvent).toHaveBeenCalledWith(FIRST_TIP_ID, "dismiss", "on");
  });

  test("learn more emits without hiding the tip", () => {
    openAllGates();
    const { result } = renderHook(() => useTipCard());
    emitTipEvent.mockClear();

    act(() => {
      result.current.onLearnMore();
    });

    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);
    expect(emitTipEvent).toHaveBeenCalledTimes(1);
    expect(emitTipEvent).toHaveBeenCalledWith(FIRST_TIP_ID, "learn_more", "on");
  });

  test("don't show again disables tips and emits", () => {
    openAllGates();
    const { result } = renderHook(() => useTipCard());
    emitTipEvent.mockClear();

    act(() => {
      result.current.onDontShowAgain();
    });

    expect(result.current.tip).toBeNull();
    expect(tipsEnabledStorage.load()).toBe(false);
    expect(emitTipEvent).toHaveBeenCalledTimes(1);
    expect(emitTipEvent).toHaveBeenCalledWith(
      FIRST_TIP_ID,
      "dont_show_again",
      "on",
    );
  });
});

describe("useTipCard demo cycler", () => {
  test("onNextTip is undefined while the cycler storage is off", () => {
    openAllGates();

    const { result } = renderHook(() => useTipCard());

    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);
    expect(result.current.onNextTip).toBeUndefined();
  });

  test("cycles the full catalog — including gated and dismissed tips — and wraps", () => {
    openAllGates();
    tipsDemoCyclerStorage.save(true);
    // A dismissed tip must still appear in the demo walk.
    recordTipDismissed(TIPS_CATALOG[2].id, Date.now());

    const { result } = renderHook(() => useTipCard());
    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);
    expect(result.current.onNextTip).toBeDefined();

    // First click jumps to the shown tip's successor; each later click
    // advances one slot. Walking length clicks covers every catalog entry
    // (gated ones included — none pass gates on web) and lands back on the
    // first tip, proving the wrap.
    for (let click = 1; click <= TIPS_CATALOG.length; click++) {
      act(() => {
        result.current.onNextTip?.();
      });
      expect(result.current.tip?.id).toBe(
        TIPS_CATALOG[click % TIPS_CATALOG.length].id,
      );
    }
  });

  test("demo-shown tips stamp no records and emit no telemetry", () => {
    openAllGates();
    tipsDemoCyclerStorage.save(true);

    const { result } = renderHook(() => useTipCard());
    // The initial real tip still records its impression as usual.
    expect(tipRecordsStorage.load()[FIRST_TIP_ID]?.shownCount).toBe(1);
    const recordsAfterRealImpression = tipRecordsStorage.load();
    emitTipEvent.mockClear();

    for (let click = 1; click <= TIPS_CATALOG.length; click++) {
      act(() => {
        result.current.onNextTip?.();
      });
    }

    expect(tipRecordsStorage.load()).toEqual(recordsAfterRealImpression);
    expect(emitTipEvent).not.toHaveBeenCalled();
  });

  test("global gates still blank the slot while demo cycling", () => {
    openAllGates();
    tipsDemoCyclerStorage.save(true);

    const { result } = renderHook(() => useTipCard());
    act(() => {
      result.current.onNextTip?.();
    });
    expect(result.current.tip?.id).toBe(TIPS_CATALOG[1].id);

    act(() => {
      useBannerVisibilityStore.getState().registerVisibleBanner();
    });
    expect(result.current.tip).toBeNull();
  });
});
