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
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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
 * The connection counts as resolved when the lifecycle has settled a
 * self-hosted phase, or an active local phase, that has not been flagged
 * unreachable. A degraded-but-responsive daemon reports `health:
 * "unhealthy"` (the probe reached `/healthz` but it returned a non-healthy
 * status) — the lifecycle service still treats that as reachable for active
 * local states (`reachable = health === "healthy" || health === "unhealthy"`
 * in `lifecycle-service.ts`), so this signal must agree: reachable unless the
 * probe could not reach the daemon at all (`health === "unreachable"`, the
 * only value `deriveLocalAssistantHealth` returns when the probe fails). The
 * `sleeping` / `starting` / `crashed` statuses come only from the
 * local-status fallback, never the self-hosted/active heartbeat path that
 * feeds this signal, so excluding `"unreachable"` matches the service's
 * active-local reachability exactly.
 *
 * Gating by active id happens in the hook (see {@link useCanReachAssistant}):
 * the lifecycle store describes the *one* active connection, so this signal is
 * only meaningful for the active assistant.
 */
function lifecycleLocalReachable(state: AssistantState): boolean {
  if (state.kind === "self_hosted") return state.health !== "unreachable";
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
 *
 * The lifecycle store describes only the *one* active connection (its token /
 * primed gateway belong to whichever assistant the lifecycle last activated),
 * and the active assistant id is tracked separately in the resolved-assistants
 * store. So the lifecycle signal is meaningful for local reachability only when
 * the queried assistant *is* the active assistant: querying a different local
 * assistant must report `false`, because we hold no primed connection for it.
 * The id gate applies to local mode; remote-gateway mode has a single shared
 * gateway (active id `"self"`), so its branch keeps using the lifecycle signal
 * directly.
 */
export function useCanReachAssistant(a: LockfileAssistant): boolean {
  const platformSession = useAuthStore.use.platformSession();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  // In local mode the lifecycle's single connection belongs to the active
  // assistant only; a non-active local assistant has no primed connection, so
  // its lifecycle-derived local reachability must be false.
  const lifecycleBelongsToTarget =
    isRemoteGatewayMode() || activeAssistantId === a.assistantId;
  return canReachAssistant(a, {
    gatewayTokenPresent: lifecycleBelongsToTarget
      ? lifecycleLocalReachable(assistantState)
      : false,
    platformSession,
  });
}
