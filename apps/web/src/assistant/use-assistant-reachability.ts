
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AssistantsConnectionStatusResponse,
  ConnectionStatus,
} from "@/generated/api/index";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { lifecycleService } from "@/assistant/lifecycle-service";

/**
 * Tracks whether the frontend can reach the assistant's runtime pod.
 *
 * Reads from the lifecycle store's `reachable` field (set by the
 * lifecycle service's background healthz probes and unreachable-bus
 * subscription) as the source of truth. The hook owns the UI-specific
 * concerns: phase state machine, failure timeout, retry/dismiss actions.
 *
 * Caller-visible semantics:
 *   * When the lifecycle store marks `reachable: false`, the hook
 *     transitions to "connecting".
 *   * When the lifecycle store marks `reachable: true`, the hook
 *     transitions to "ready".
 *   * Imperative `probe()` calls delegate to
 *     `lifecycleService.triggerReachabilityProbe()`.
 */
export const RECHECK_INTERVAL_MS = 4_000;
export const MAX_ATTEMPTS = 8;
export const MAX_WINDOW_MS = 60_000;
export const BUS_REENTRY_COOLDOWN_MS = 5_000;

export type ReachabilityPhase =
  | "idle"
  | "checking"
  | "connecting"
  | "ready"
  | "retrying"
  | "failed";

export type ReachabilityState =
  | { phase: "idle" }
  | { phase: "checking" }
  | {
      phase: "connecting";
      attempt: number;
      isPodWaking: boolean;
      lastServerState: ConnectionServerState | null;
    }
  | { phase: "ready" }
  | { phase: "retrying" }
  | {
      phase: "failed";
      isPodWaking: boolean;
      lastServerState: ConnectionServerState | null;
      detail: string | null;
    };

export type ConnectionServerState = AssistantsConnectionStatusResponse["state"];

export interface UseAssistantReachabilityResult {
  state: ReachabilityState;
  probe: (options?: ReachabilityProbeOptions) => void;
  reset: () => void;
}

export interface ReachabilityProbeOptions {
  showConnectingImmediately?: boolean;
  /** @internal Used by passive probes that should not interrupt the user. */
  mode?: ReachabilityProbeMode;
  /** @internal Used by passive probes to hide one transient miss. */
  silentGracePeriod?: boolean;
}

export type ReachabilityProbeMode = "visible" | "background";

/**
 * Returns true when the probe result indicates the pod is in a crash loop.
 * Retained for consumers that import it directly.
 */
export function shouldFailReachabilityImmediately(
  serverState: ConnectionServerState,
  response?: ConnectionStatus | null,
): boolean {
  if (serverState === "crash_loop") {
    return true;
  }
  if (serverState === "waking" && response?.crash_loop_since != null) {
    return true;
  }
  return false;
}

export function shouldDeferReachabilityOverlay({
  probeResponseCount,
  silentGracePeriod,
}: {
  probeResponseCount: number;
  silentGracePeriod: boolean;
}): boolean {
  return silentGracePeriod && probeResponseCount === 1;
}

export function useAssistantReachability(
  assistantId: string | null,
): UseAssistantReachabilityResult {
  const [state, setState] = useState<ReachabilityState>({ phase: "idle" });
  const dismissedAtRef = useRef<number>(0);
  const readyAtRef = useRef<number>(0);
  const failureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFailureTimer = useCallback(() => {
    if (failureTimerRef.current !== null) {
      clearTimeout(failureTimerRef.current);
      failureTimerRef.current = null;
    }
  }, []);

  /** Enter "connecting" with a MAX_WINDOW_MS timeout to "failed". */
  const enterConnecting = useCallback(() => {
    clearFailureTimer();
    failureTimerRef.current = setTimeout(() => {
      setState({
        phase: "failed",
        isPodWaking: false,
        lastServerState: null,
        detail: null,
      });
    }, MAX_WINDOW_MS);
    setState({
      phase: "connecting",
      attempt: 0,
      isPodWaking: false,
      lastServerState: null,
    });
  }, [clearFailureTimer]);

  const reset = useCallback(() => {
    clearFailureTimer();
    dismissedAtRef.current = Date.now();
    setState({ phase: "idle" });
  }, [clearFailureTimer]);

  const probe = useCallback((options?: ReachabilityProbeOptions) => {
    if (!assistantId) return;
    const mode = options?.mode ?? "visible";
    const showConnectingImmediately =
      mode === "visible" && (options?.showConnectingImmediately ?? true);

    if (showConnectingImmediately) {
      enterConnecting();
    } else if (mode === "background") {
      setState({ phase: "checking" });
    }

    lifecycleService.triggerReachabilityProbe();
  }, [assistantId, enterConnecting]);

  // Subscribe to the lifecycle store's reachable field. When the
  // lifecycle service transitions reachable true/false, derive the
  // hook's phase from it.
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const storeReachable =
    assistantState.kind === "active" ? assistantState.reachable : undefined;

  const prevReachableRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const prev = prevReachableRef.current;
    prevReachableRef.current = storeReachable;

    if (storeReachable === undefined) return;

    if (storeReachable === true) {
      if (prev === true) return;
      clearFailureTimer();
      readyAtRef.current = Date.now();
      setState({ phase: "ready" });
      return;
    }

    // storeReachable === false
    if (prev !== false) {
      const sinceDismiss = Date.now() - dismissedAtRef.current;
      const sinceReady = Date.now() - readyAtRef.current;
      if (
        sinceDismiss <= BUS_REENTRY_COOLDOWN_MS ||
        sinceReady <= BUS_REENTRY_COOLDOWN_MS
      ) {
        setState({ phase: "checking" });
      } else {
        enterConnecting();
      }
    }
  }, [storeReachable, clearFailureTimer, enterConnecting]);

  // Reset on assistant switch or unmount.
  useEffect(() => {
    return () => {
      clearFailureTimer();
      dismissedAtRef.current = 0;
      readyAtRef.current = 0;
      prevReachableRef.current = undefined;
      setState({ phase: "idle" });
    };
  }, [assistantId, clearFailureTimer]);

  return useMemo(
    () => ({ state, probe, reset }),
    [state, probe, reset],
  );
}
