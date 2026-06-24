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
   * Whether the gateway token valid for THIS assistant is present. Must be a
   * per-assistant signal: a bare `getGatewayToken() !== null` is wrong with
   * multiple local assistants, since a token minted for another assistant would
   * make this one report reachable. Callers gate the global token by active id.
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
