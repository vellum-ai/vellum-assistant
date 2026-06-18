import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { AssistantState } from "@/assistant/types";
import {
  isLocalAssistant,
  isLocalMode,
  isPlatformAssistant,
  isRemoteGatewayMode,
  type LockfileAssistant,
} from "@/lib/local-mode";
import { useAuthStore } from "@/stores/auth-store";
import {
  hasLivePlatformSession,
  type PlatformSessionStatus,
} from "@/stores/session-status";

/**
 * The connection signals `canReachAssistant` reasons over, passed in rather
 * than read from a store so the predicate stays pure and unit-testable and can
 * be called from imperative paths.
 */
export interface ReachabilitySignals {
  /**
   * Whether the gateway token currently valid for THIS target assistant is
   * present. Callers MUST supply a per-assistant signal: a bare
   * `getGatewayToken() !== null` is incorrect when multiple local assistants
   * exist, because a token minted for a different assistant would make this
   * assistant report reachable. The reactive `useCanReachAssistant` hook
   * derives this from the per-assistant lifecycle connection state.
   */
  gatewayTokenPresent: boolean;
  platformSession: PlatformSessionStatus;
}

/**
 * Can the app currently reach this assistant? The credential depends on hosting
 * type: a gateway token for local / remote-gateway assistants, a live platform
 * session for platform-hosted ones. Mirrors the interceptor routing in
 * `api-interceptors.ts`.
 */
export function canReachAssistant(
  a: LockfileAssistant,
  s: ReachabilitySignals,
): boolean {
  if (isRemoteGatewayMode()) return s.gatewayTokenPresent;
  if (isLocalMode() && isLocalAssistant(a)) return s.gatewayTokenPresent;
  if (isPlatformAssistant(a)) return hasLivePlatformSession(s.platformSession);
  return false;
}

/**
 * Per-assistant local reachability derived from the reactive lifecycle state —
 * the `gatewayTokenPresent` signal `canReachAssistant` reasons over for the
 * local / remote-gateway branches.
 *
 * Read from the lifecycle store rather than `getGatewayToken()`, which is
 * non-reactive module/localStorage state: a hook reading it would not re-render
 * when the connection comes or goes. Just as importantly, the token is global,
 * so a bare `getGatewayToken() !== null` would make assistant B report reachable
 * off a token minted for assistant A. The lifecycle store tracks the reachable
 * connection for the *one* active assistant, so deriving from it keeps the
 * signal per-assistant.
 *
 * The connection counts as resolved when the lifecycle has settled a healthy
 * self-hosted phase, or an active local phase that has not been flagged
 * unreachable.
 */
function lifecycleLocalReachable(state: AssistantState): boolean {
  if (state.kind === "self_hosted") return state.health === "healthy";
  if (state.kind === "active") {
    return (
      state.isLocal &&
      state.reachable !== false &&
      state.health !== "unreachable"
    );
  }
  return false;
}

/**
 * Reactive `canReachAssistant`: subscribes to the per-assistant lifecycle state
 * and the platform identity, then delegates the hosting-branch decision to the
 * pure predicate so the routing logic lives in exactly one place. The hook only
 * supplies the reactive signals — the local one from the lifecycle state, not
 * `getGatewayToken()` (see {@link lifecycleLocalReachable}).
 */
export function useCanReachAssistant(a: LockfileAssistant): boolean {
  const platformSession = useAuthStore.use.platformSession();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  return canReachAssistant(a, {
    gatewayTokenPresent: lifecycleLocalReachable(assistantState),
    platformSession,
  });
}
