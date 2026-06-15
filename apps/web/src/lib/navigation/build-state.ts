import { useAuthStore } from "@/stores/auth-store";
import { isSessionSettled, isAuthenticated } from "@/stores/session-status";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { isLocalMode } from "@/lib/local-mode";
import {
  readTosAccepted,
  readAiDataConsent,
} from "@/domains/onboarding/prefs";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { NavigationState } from "./navigation-resolver";

// Store key for `experiment-activation-flow-2026-06-03` (camelCase), matching
// `ACTIVATION_FLOW_STORE_KEY` in `hooks/use-client-feature-flag-sync.ts`. The
// store's `stringFlags` already folds in any localStorage override.
const ACTIVATION_FLOW_STORE_KEY = "experimentActivationFlow20260603";
const CAST_ARM = "personal-page";

function isCastArm(): boolean {
  // Local mode never runs the platform activation experiment.
  if (isLocalMode()) return false;
  return (
    useClientFeatureFlagStore.getState().stringFlags[
      ACTIVATION_FLOW_STORE_KEY
    ] === CAST_ARM
  );
}

export function buildNavigationState(
  overrides?: Partial<NavigationState>,
): NavigationState {
  const { sessionStatus, platformSession } = useAuthStore.getState();
  return {
    isLocalMode: isLocalMode(),
    isGatewayAuth: isGatewayAuthMode(),
    hasAssistants: useResolvedAssistantsStore.getState().assistants.length > 0,
    sessionSettled: isSessionSettled(sessionStatus),
    isAuthenticated: isAuthenticated(sessionStatus),
    platformSession,
    tosAccepted: readTosAccepted(),
    aiDataConsent: readAiDataConsent(),
    isCastArm: isCastArm(),
    ...overrides,
  };
}
