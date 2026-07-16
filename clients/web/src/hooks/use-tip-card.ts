/**
 * Orchestration for the proactive tip card: evaluates the surface gates
 * (feature flag, "show tips" preference, nudge-banner exclusivity, new-user
 * grace), filters the tips catalog by per-tip gates, selects the current tip
 * via the cadence policy, and owns persistence + telemetry for impressions
 * and user actions.
 *
 * Rendering lives in `TipCard` (`components/tips/tip-card.tsx`); this hook
 * returns `tip: null` whenever nothing should show.
 */

import { useCallback, useEffect, useState } from "react";

import {
  isProactiveTipsOn,
  useProactiveTipsVariant,
} from "@/hooks/use-proactive-tips-flag";
import { useSupportsPluginsSurface } from "@/lib/backwards-compat/plugins-surface";
import { isElectron } from "@/runtime/is-electron";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
  useBannerVisibilityStore,
  useBannerVisible,
} from "@/stores/banner-visibility-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { TIPS_CATALOG, type Tip } from "@/utils/tips-catalog";
import {
  selectCurrentTip,
  TIP_ROTATION_INTERVAL_MS,
} from "@/utils/tips-selection";
import {
  ensureTipsFirstSeenAt,
  recordTipDismissed,
  recordTipShown,
  tipRecordsStorage,
  tipsEnabledStorage,
  tipsFirstSeenAtStorage,
} from "@/utils/tips-storage";
import { emitTipEvent } from "@/utils/tips-telemetry";

/** New-user grace: no tips until the account is at least this old. */
export const TIPS_MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

interface TipGateContext {
  electron: boolean;
  pluginsSurface: boolean;
  clientFlags: Record<string, boolean>;
  assistantFlags: Record<string, boolean>;
}

function tipPassesGates(tip: Tip, ctx: TipGateContext): boolean {
  const gates = tip.gates;
  if (!gates) {
    return true;
  }
  if (gates.requiresElectron && !ctx.electron) {
    return false;
  }
  if (
    gates.requiresClientFlag &&
    ctx.clientFlags[gates.requiresClientFlag] !== true
  ) {
    return false;
  }
  if (
    gates.requiresAssistantFlag &&
    ctx.assistantFlags[gates.requiresAssistantFlag] !== true
  ) {
    return false;
  }
  if (gates.requiresPluginsSurface && !ctx.pluginsSurface) {
    return false;
  }
  return true;
}

export interface UseTipCardResult {
  /** The tip to render, or `null` when no tip should show. */
  tip: Tip | null;
  /** Zero-based position of the shown tip among the browsable tips. */
  carouselIndex: number;
  /** Number of browsable (gate-passing) tips — drives the carousel dots. */
  carouselCount: number;
  onDismiss: () => void;
  onLearnMore: () => void;
  /** Carousel navigation — clamped at the catalog edges. */
  onPrevTip: () => void;
  onNextTip: () => void;
}

export function useTipCard(): UseTipCardResult {
  // Whole-store subscriptions: tip gates reference flags by dynamic key, so
  // per-key selectors can't be used (same pattern as the feature-flags panel).
  const clientFlagState = useClientFeatureFlagStore();
  const assistantFlagState = useAssistantFeatureFlagStore();
  const bannerVisible = useBannerVisible();
  const supportsPluginsSurface = useSupportsPluginsSurface();
  const tipsEnabled = tipsEnabledStorage.useValue();
  const records = tipRecordsStorage.useValue();
  const firstSeenAt = tipsFirstSeenAtStorage.useValue();

  const variant = useProactiveTipsVariant();

  // Clock state for selection: reading Date.now() during render is impure
  // (react-hooks/purity), so renders see a snapshot that the rotation-boundary
  // timer below refreshes whenever the selection outcome can change.
  const [now, setNow] = useState(() => Date.now());
  const [ageEligible, setAgeEligible] = useState(false);
  // Carousel browse position (null = show the cadence-selected tip), and a
  // session-local "closed" latch for dismissing while browsed away from the
  // selected tip (which stays pinned for the day, so selection alone can't
  // blank the slot).
  const [browseIndex, setBrowseIndex] = useState<number | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    ensureTipsFirstSeenAt();
  }, []);

  // Flip eligibility mid-session once the age threshold elapses. For a 24h
  // gate this rarely fires in-session; the recompute below runs again on the
  // user's next visit, which is the real trigger.
  useEffect(() => {
    if (firstSeenAt === 0) {
      setAgeEligible(false);
      return;
    }
    const remaining = TIPS_MIN_ACCOUNT_AGE_MS - (Date.now() - firstSeenAt);
    if (remaining <= 0) {
      setAgeEligible(true);
      return;
    }
    setAgeEligible(false);
    const timer = setTimeout(() => setAgeEligible(true), remaining);
    return () => clearTimeout(timer);
  }, [firstSeenAt]);

  // Refresh the clock when a rotation window elapses mid-session, so a pinned
  // tip rotates (or a dismissed tip's successor appears) without a remount.
  // Selection keys rotation on lastShownAt only, so the next boundary is the
  // earliest future lastShownAt + window. `now` is a dependency so an
  // early-firing timer reschedules itself for the remaining delay.
  useEffect(() => {
    let nextBoundary = Infinity;
    for (const record of Object.values(records)) {
      if (record.lastShownAt === undefined) {
        continue;
      }
      const boundary = record.lastShownAt + TIP_ROTATION_INTERVAL_MS;
      if (boundary > now && boundary < nextBoundary) {
        nextBoundary = boundary;
      }
    }
    if (nextBoundary === Infinity) {
      return;
    }
    // Clamp: a skewed lastShownAt could push the delay past setTimeout's
    // ~24.8-day ceiling; an early fire simply reschedules.
    const delay = Math.min(
      Math.max(nextBoundary - Date.now(), 0),
      TIP_ROTATION_INTERVAL_MS,
    );
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [records, now]);

  const gatesOpen =
    isProactiveTipsOn(variant) && tipsEnabled && !bannerVisible && ageEligible;

  const eligibleCatalog = TIPS_CATALOG.filter((tip) =>
    tipPassesGates(tip, {
      electron: isElectron(),
      pluginsSurface: supportsPluginsSurface,
      clientFlags: clientFlagState,
      assistantFlags: assistantFlagState,
    }),
  );

  const selectedTip = gatesOpen
    ? selectCurrentTip(eligibleCatalog, records, now)
    : null;
  const selectedTipId = selectedTip?.id ?? null;

  // A new rotation window (or dismissal of the selected tip) resets the
  // carousel back to the cadence view and reopens a closed card.
  useEffect(() => {
    setBrowseIndex(null);
    setClosed(false);
  }, [selectedTipId]);

  // Carousel browsing moves through the gate-passing catalog in order —
  // including previously dismissed tips, since paging to one is deliberate.
  const browsedTip =
    gatesOpen && browseIndex !== null && eligibleCatalog.length > 0
      ? eligibleCatalog[
          Math.min(Math.max(browseIndex, 0), eligibleCatalog.length - 1)
        ]
      : null;

  const tip = closed ? null : (browsedTip ?? selectedTip);
  const tipId = tip?.id ?? null;

  const carouselCount = eligibleCatalog.length;
  const carouselIndex =
    tipId === null
      ? 0
      : Math.max(
          0,
          eligibleCatalog.findIndex((entry) => entry.id === tipId),
        );

  // Impression stamping is driven off the persisted record (not component
  // lifecycle), so remounts and re-renders within a rotation window never
  // double-count: a tip already shown within the window is skipped.
  useEffect(() => {
    if (selectedTipId === null || closed) {
      return;
    }
    // Carousel browsing must not consume the real rotation state — only the
    // cadence-selected tip counts as an impression, and only while it is the
    // one actually displayed.
    if (browseIndex !== null) {
      return;
    }
    // Layout effects flush before passive effects, so this read sees a banner
    // registered in this commit that the render's `bannerVisible` missed.
    if (useBannerVisibilityStore.getState().visibleBannerCount > 0) {
      return;
    }
    const record = tipRecordsStorage.load()[selectedTipId];
    // Judge the window with the same clock selection used (`now` is a dep):
    // when the boundary timer refreshes it and the same tip stays selected,
    // this re-runs and restamps the new window. Without that, a pinned tip's
    // stale lastShownAt lets a late dismissal skip the next-window wait.
    const shownWithinWindow =
      record?.lastShownAt !== undefined &&
      now - record.lastShownAt < TIP_ROTATION_INTERVAL_MS;
    if (shownWithinWindow) {
      return;
    }
    recordTipShown(selectedTipId, Date.now());
    emitTipEvent(selectedTipId, "impression", variant);
  }, [selectedTipId, variant, browseIndex, closed, now]);

  const onPrevTip = useCallback(() => {
    setBrowseIndex(Math.max(carouselIndex - 1, 0));
  }, [carouselIndex]);

  const onNextTip = useCallback(() => {
    setBrowseIndex(Math.min(carouselIndex + 1, carouselCount - 1));
  }, [carouselIndex, carouselCount]);

  const onDismiss = useCallback(() => {
    if (tipId === null) {
      return;
    }
    recordTipDismissed(tipId, Date.now());
    emitTipEvent(tipId, "dismiss", variant);
    // Dismissing a browsed tip leaves the selected tip pinned for the day, so
    // latch the card closed; the latch resets when the selection changes.
    setBrowseIndex(null);
    setClosed(true);
  }, [tipId, variant]);

  const onLearnMore = useCallback(() => {
    if (tipId === null) {
      return;
    }
    emitTipEvent(tipId, "learn_more", variant);
  }, [tipId, variant]);

  return {
    tip,
    carouselIndex,
    carouselCount,
    onDismiss,
    onLearnMore,
    onPrevTip,
    onNextTip,
  };
}
