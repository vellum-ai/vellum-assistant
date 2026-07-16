/**
 * Hooks for the sidenav-gating experiment: flag-arm resolution and the two
 * layout-scope side effects (one-shot sidebar collapse for the gated arm, and
 * the `session_end_without_message` counter-metric signal for both arms).
 */

import { useEffect, useRef } from "react";

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import {
  FULL_UNLOCK_COUNT,
  useNavGateStore,
  type NavGateArm,
} from "@/domains/chat/nav-gate/nav-gate-store";
import { emitSessionEndWithoutMessage } from "@/domains/chat/nav-gate/nav-gate-telemetry";

/**
 * The experiment arm. Flags hydrate asynchronously, so a cold load reads
 * `none` (no gating, no events) until the first flag response — the brief
 * ungated window is accepted for the spike rather than blocking the sidenav
 * on flag hydration.
 */
export function useNavGateArm(): NavGateArm {
  const stringFlags = useClientFeatureFlagStore.use.stringFlags();
  const raw = stringFlags.sidenavGatingExperiment20260716;
  return raw === "gated" || raw === "control" ? raw : "none";
}

/**
 * Mounted once in ChatLayout. Applies the gated arm's collapsed-by-default
 * sidebar (through the existing one-shot collapse channel ChatLayout already
 * consumes) and emits the session-end counter-metric on pagehide when the
 * user has never sent a message — for BOTH cohort arms, since it's the
 * gating-just-converts-wanderers-into-bounces check.
 */
export function useNavGateExperimentEffects(arm: NavGateArm): void {
  useEffect(() => {
    if (arm !== "gated") {
      return;
    }
    const state = useNavGateStore.getState();
    if (state.collapseApplied || state.sentCount >= FULL_UNLOCK_COUNT) {
      return;
    }
    state.markCollapseApplied();
    useOnboardingFocusStore.getState().requestSidebarCollapse();
  }, [arm]);

  const emittedRef = useRef(false);
  useEffect(() => {
    if (arm === "none") {
      return;
    }
    const onPageHide = () => {
      if (emittedRef.current) {
        return;
      }
      if (useNavGateStore.getState().sentCount === 0) {
        emittedRef.current = true;
        emitSessionEndWithoutMessage(arm);
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [arm]);
}
