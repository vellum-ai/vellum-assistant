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

// Whether the client feature-flag fetch has settled, so the cast-arm decision
// can be trusted. Read off the store's `loaded`. Guarded `false` in local mode,
// consistent with how `isCastArm` is gated there — the activation experiment
// never runs locally, and the local-mode branch of `requireAssistant` returns
// before the settle check, so this never makes local users wait.
function activationArmSettled(): boolean {
  if (isLocalMode()) return false;
  return useClientFeatureFlagStore.getState().loaded;
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
    activationArmSettled: activationArmSettled(),
    ...overrides,
  };
}
