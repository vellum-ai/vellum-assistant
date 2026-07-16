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
  tipsEnabledStorage,
  tipsFirstSeenAtStorage,
} = await import("@/utils/tips-storage");

const FIRST_TIP_ID = TIPS_CATALOG[0].id;
// The browsable catalog in this environment: tips whose gates pass on web
// (no Electron, no flags, no plugins surface) — i.e. the ungated ones.
const UNGATED_TIPS = TIPS_CATALOG.filter((tip) => !tip.gates);
// Successor on web once the first tip is dismissed.
const SECOND_UNGATED_TIP_ID = UNGATED_TIPS[1].id;

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
  test("restamps a pinned tip's impression when the window elapses while mounted", async () => {
    openAllGates();
    const { result } = renderHook(() => useTipCard());
    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);
    expect(tipRecordsStorage.load()[FIRST_TIP_ID]?.shownCount).toBe(1);
    emitTipEvent.mockClear();

    // Rewind the stamp so the rotation boundary lands ~40ms from now. The
    // undismissed first tip is re-selected for the new window; without the
    // restamp its stale lastShownAt would let a late dismissal skip the
    // next-window wait.
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

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);
    const record = tipRecordsStorage.load()[FIRST_TIP_ID];
    expect(record?.shownCount).toBe(2);
    expect(Date.now() - (record?.lastShownAt ?? 0)).toBeLessThan(
      TIP_ROTATION_INTERVAL_MS,
    );
    expect(emitTipEvent).toHaveBeenCalledTimes(1);
    expect(emitTipEvent).toHaveBeenCalledWith(FIRST_TIP_ID, "impression", "on");
  });

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

});

describe("useTipCard carousel", () => {
  test("browses forward and back through the gate-passing catalog", () => {
    openAllGates();

    const { result } = renderHook(() => useTipCard());
    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);
    expect(result.current.carouselIndex).toBe(0);
    expect(result.current.carouselCount).toBe(UNGATED_TIPS.length);

    act(() => {
      result.current.onNextTip();
    });
    expect(result.current.tip?.id).toBe(SECOND_UNGATED_TIP_ID);
    expect(result.current.carouselIndex).toBe(1);

    act(() => {
      result.current.onPrevTip();
    });
    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);
    expect(result.current.carouselIndex).toBe(0);
  });

  test("clamps at the catalog edges instead of wrapping", () => {
    openAllGates();

    const { result } = renderHook(() => useTipCard());
    act(() => {
      result.current.onPrevTip();
    });
    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);

    for (let click = 0; click < UNGATED_TIPS.length + 3; click++) {
      act(() => {
        result.current.onNextTip();
      });
    }
    expect(result.current.tip?.id).toBe(UNGATED_TIPS.at(-1)?.id);
    expect(result.current.carouselIndex).toBe(UNGATED_TIPS.length - 1);
  });

  test("browsing includes previously dismissed tips", () => {
    openAllGates();
    recordTipDismissed(SECOND_UNGATED_TIP_ID, Date.now());

    const { result } = renderHook(() => useTipCard());
    expect(result.current.tip?.id).toBe(FIRST_TIP_ID);

    act(() => {
      result.current.onNextTip();
    });
    expect(result.current.tip?.id).toBe(SECOND_UNGATED_TIP_ID);
  });

  test("browsed tips stamp no records and emit no impressions", () => {
    openAllGates();

    const { result } = renderHook(() => useTipCard());
    // The initial cadence-selected tip still records its impression as usual.
    expect(tipRecordsStorage.load()[FIRST_TIP_ID]?.shownCount).toBe(1);
    const recordsAfterRealImpression = tipRecordsStorage.load();
    emitTipEvent.mockClear();

    for (let click = 0; click < UNGATED_TIPS.length; click++) {
      act(() => {
        result.current.onNextTip();
      });
    }
    act(() => {
      result.current.onPrevTip();
    });

    expect(tipRecordsStorage.load()).toEqual(recordsAfterRealImpression);
    expect(emitTipEvent).not.toHaveBeenCalled();
  });

  test("learn more emits the browsed tip's id", () => {
    openAllGates();
    const { result } = renderHook(() => useTipCard());
    act(() => {
      result.current.onNextTip();
    });
    emitTipEvent.mockClear();

    act(() => {
      result.current.onLearnMore();
    });

    expect(emitTipEvent).toHaveBeenCalledWith(
      SECOND_UNGATED_TIP_ID,
      "learn_more",
      "on",
    );
  });

  test("dismissing a browsed tip records it and closes the card, sparing the selected tip", () => {
    openAllGates();
    const { result } = renderHook(() => useTipCard());
    act(() => {
      result.current.onNextTip();
    });
    emitTipEvent.mockClear();

    act(() => {
      result.current.onDismiss();
    });

    expect(result.current.tip).toBeNull();
    const records = tipRecordsStorage.load();
    expect(records[SECOND_UNGATED_TIP_ID]?.dismissedAt).toBeGreaterThan(0);
    expect(records[FIRST_TIP_ID]?.dismissedAt).toBeUndefined();
    expect(emitTipEvent).toHaveBeenCalledTimes(1);
    expect(emitTipEvent).toHaveBeenCalledWith(
      SECOND_UNGATED_TIP_ID,
      "dismiss",
      "on",
    );
  });

  test("global gates still blank the slot while browsing", () => {
    openAllGates();

    const { result } = renderHook(() => useTipCard());
    act(() => {
      result.current.onNextTip();
    });
    expect(result.current.tip?.id).toBe(SECOND_UNGATED_TIP_ID);

    act(() => {
      useBannerVisibilityStore.getState().registerVisibleBanner();
    });
    expect(result.current.tip).toBeNull();
  });
});
