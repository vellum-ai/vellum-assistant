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
  onDismiss: () => void;
  onLearnMore: () => void;
  onDontShowAgain: () => void;
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

  const tip = gatesOpen
    ? selectCurrentTip(eligibleCatalog, records, now)
    : null;
  const tipId = tip?.id ?? null;

  // Impression stamping is driven off the persisted record (not component
  // lifecycle), so remounts and re-renders within a rotation window never
  // double-count: a tip already shown within the window is skipped.
  useEffect(() => {
    if (tipId === null) {
      return;
    }
    // Layout effects flush before passive effects, so this read sees a banner
    // registered in this commit that the render's `bannerVisible` missed.
    if (useBannerVisibilityStore.getState().visibleBannerCount > 0) {
      return;
    }
    const shownAt = Date.now();
    const record = tipRecordsStorage.load()[tipId];
    const shownWithinWindow =
      record?.lastShownAt !== undefined &&
      shownAt - record.lastShownAt < TIP_ROTATION_INTERVAL_MS;
    if (shownWithinWindow) {
      return;
    }
    recordTipShown(tipId, shownAt);
    emitTipEvent(tipId, "impression", variant);
  }, [tipId, variant]);

  const onDismiss = useCallback(() => {
    if (tipId === null) {
      return;
    }
    recordTipDismissed(tipId, Date.now());
    emitTipEvent(tipId, "dismiss", variant);
  }, [tipId, variant]);

  const onLearnMore = useCallback(() => {
    if (tipId === null) {
      return;
    }
    emitTipEvent(tipId, "learn_more", variant);
  }, [tipId, variant]);

  const onDontShowAgain = useCallback(() => {
    if (tipId === null) {
      return;
    }
    tipsEnabledStorage.save(false);
    emitTipEvent(tipId, "dont_show_again", variant);
  }, [tipId, variant]);

  return { tip, onDismiss, onLearnMore, onDontShowAgain };
}
