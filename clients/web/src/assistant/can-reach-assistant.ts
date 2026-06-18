import {
  isLocalAssistant,
  isLocalMode,
  isPlatformAssistant,
  isRemoteGatewayMode,
  type LockfileAssistant,
} from "@/lib/local-mode";
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
