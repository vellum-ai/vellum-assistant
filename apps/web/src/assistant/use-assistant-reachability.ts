
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assistantsConnectionStatus,
  type AssistantsConnectionStatusResponse,
  type ConnectionStatus,
} from "@/generated/api/index";
import { subscribeAssistantUnreachable } from "@/assistant/unreachable-bus";

/**
 * Tracks whether the frontend can reach the assistant's runtime pod.
 *
 * The flow is driven by a user-initiated ``probe()`` call (e.g. after a
 * chat stream errors). Once started, we poll the backend's
 * ``/connection-status/`` endpoint which in turn asks vembda whether the
 * pod is awake, waking up from idle-sleep, or stuck in a crash loop.
 *
 * Caller-visible semantics:
 *   * We give up to ``MAX_ATTEMPTS`` non-waking probes inside a
 *     ``MAX_WINDOW_MS`` budget before surfacing a failure.
 *   * Probes that come back as ``waking`` do **not** consume retry
 *     attempts, but the ``MAX_WINDOW_MS`` wall-clock cap still applies
 *     so a pod that never finishes waking cannot trap the user behind
 *     the overlay indefinitely.
 *   * Any probe returning ``ready`` immediately clears the overlay.
 */
export const RECHECK_INTERVAL_MS = 4_000;
export const MAX_ATTEMPTS = 8;
export const MAX_WINDOW_MS = 60_000;
// Cooldown applied after a successful probe before the unreachable-bus
// subscriber is willing to start a new probe cycle. Prevents a burst of
// 502/503/504 responses from in-flight refetches (conversations, identity,
// avatar, etc.) -- which can briefly arrive right after the pod reports
// ready -- from immediately re-opening the connecting overlay.
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

interface RunProbeOptions {
  keepIdleOnReady: boolean;
  mode: ReachabilityProbeMode;
  silentGracePeriod: boolean;
}

/**
 * Returns true when the probe result indicates the pod is in a crash loop
 * and the reachability hook should transition to "failed" immediately
 * instead of continuing to poll.
 *
 * Checks the top-level ``state`` field first.  For ``waking`` states it
 * also inspects the ``crash_loop_since`` timestamp to catch a backend
 * edge case during CrashLoopBackOff cycles: K8s briefly restarts the
 * pod (PENDING), which the backend may report as ``waking`` even though
 * a recent crash is recorded.  The gate to ``waking`` only prevents
 * transient ``unreachable`` or ``not_found`` probes (which also carry
 * ``crash_loop_since`` from Redis) from being misclassified as active
 * crash loops.
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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<number>(0);
  const attemptsRef = useRef<number>(0);
  const generationRef = useRef<number>(0);
  const probeResponsesRef = useRef<number>(0);
  const readyAtRef = useRef<number>(0);
  const dismissedAtRef = useRef<number>(0);
  const activeAssistantIdRef = useRef<string | null>(null);
  // True while a probe cycle is in flight — including during silent
  // visible grace periods and background checks. Prevents the
  // unreachable-bus subscriber from restarting probe cycles on every
  // 502/503/504, which would reset attemptsRef and cancel the pending
  // timer, trapping the hook in the first-silent-failure path forever.
  const probingRef = useRef(false);
  const runProbeRef = useRef<(
    generation: number,
    options: RunProbeOptions,
  ) => Promise<void>>(async () => {});

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    generationRef.current += 1;
    attemptsRef.current = 0;
    probeResponsesRef.current = 0;
    startedAtRef.current = 0;
    readyAtRef.current = 0;
    dismissedAtRef.current = Date.now();
    activeAssistantIdRef.current = null;
    probingRef.current = false;
    setState({ phase: "idle" });
  }, [clearTimer]);

  const runProbe = useCallback(
    async (
      generation: number,
      options: RunProbeOptions,
    ) => {
      const id = activeAssistantIdRef.current;
      if (!id) {
        return;
      }
      let response: AssistantsConnectionStatusResponse | null = null;
      try {
        const result = await assistantsConnectionStatus({
          path: { id },
          throwOnError: false,
        });
        response = result.data ?? null;
      } catch {
        response = null;
      }

      if (generation !== generationRef.current) {
        return;
      }

      const probeResponseCount = probeResponsesRef.current + 1;
      probeResponsesRef.current = probeResponseCount;
      const serverState = response?.state ?? "unreachable";
      const isPodWaking = serverState === "waking";
      const elapsed = Date.now() - startedAtRef.current;

      if (serverState === "ready") {
        clearTimer();
        readyAtRef.current = Date.now();
        probingRef.current = false;
        setState((current) =>
          options.keepIdleOnReady && current.phase === "idle"
            ? { phase: "idle" }
            : { phase: "ready" },
        );
        return;
      }

      if (shouldFailReachabilityImmediately(serverState, response)) {
        clearTimer();
        probingRef.current = false;
        if (options.mode === "background") {
          setState({ phase: "retrying" });
          return;
        }
        setState({
          phase: "failed",
          isPodWaking: false,
          lastServerState:
            serverState === "crash_loop" ? serverState : "crash_loop",
          detail: response?.detail ?? null,
        });
        return;
      }

      if (!isPodWaking) {
        attemptsRef.current += 1;
      }

      const budgetExhausted =
        (!isPodWaking && attemptsRef.current >= MAX_ATTEMPTS) ||
        elapsed >= MAX_WINDOW_MS;

      if (budgetExhausted) {
        clearTimer();
        probingRef.current = false;
        if (options.mode === "background") {
          setState({ phase: "retrying" });
          return;
        }
        setState({
          phase: "failed",
          isPodWaking,
          lastServerState: serverState,
          detail: response?.detail ?? null,
        });
        return;
      }

      // Silent probes are used for proactive/background checks. Suppress the
      // first non-ready result, including a one-off "waking" response, so a
      // transient PENDING pod observation does not flash the modal.
      if (
        options.mode === "background" ||
        shouldDeferReachabilityOverlay({
          probeResponseCount,
          silentGracePeriod: options.silentGracePeriod,
        })
      ) {
        timerRef.current = setTimeout(() => {
          void runProbeRef.current(generation, options);
        }, RECHECK_INTERVAL_MS);
        return;
      }

      setState({
        phase: "connecting",
        attempt: attemptsRef.current,
        isPodWaking,
        lastServerState: serverState,
      });

      timerRef.current = setTimeout(() => {
        void runProbeRef.current(generation, options);
      }, RECHECK_INTERVAL_MS);
    },
    [clearTimer],
  );

  useEffect(() => {
    runProbeRef.current = runProbe;
  }, [runProbe]);

  const probe = useCallback((options?: ReachabilityProbeOptions) => {
    if (!assistantId) {
      return;
    }
    const mode = options?.mode ?? "visible";
    clearTimer();
    generationRef.current += 1;
    attemptsRef.current = 0;
    probeResponsesRef.current = 0;
    startedAtRef.current = Date.now();
    activeAssistantIdRef.current = assistantId;
    probingRef.current = true;
    const showConnectingImmediately =
      mode === "visible" && (options?.showConnectingImmediately ?? true);
    if (showConnectingImmediately) {
      setState({
        phase: "connecting",
        attempt: 0,
        isPodWaking: false,
        lastServerState: null,
      });
    } else if (mode === "background") {
      setState({ phase: "checking" });
    }
    const silentGracePeriod =
      options?.silentGracePeriod ?? !showConnectingImmediately;
    void runProbe(generationRef.current, {
      keepIdleOnReady: mode === "visible" && !showConnectingImmediately,
      mode,
      silentGracePeriod,
    });
  }, [assistantId, clearTimer, runProbe]);

  // Reset probe state on assistant switch (or unmount) so an in-flight probe
  // for a previous assistant can't leak "ready" / "failed" overlays into the
  // UI for the newly-active assistant.
  useEffect(() => {
    return () => {
      clearTimer();
      generationRef.current += 1;
      attemptsRef.current = 0;
      probeResponsesRef.current = 0;
      startedAtRef.current = 0;
      activeAssistantIdRef.current = null;
      probingRef.current = false;
      setState({ phase: "idle" });
    };
  }, [assistantId, clearTimer]);

  // Kick off a probe when *any* request to the backend comes back with
  // a gateway-ish status (502/503/504) -- the HTTP client publishes to
  // the unreachable bus. This lets the connecting overlay surface on
  // initial page load when the pod is restarting, not just on SSE
  // stream errors.
  //
  // We only start a new probe when idle; an in-flight probe already
  // owns the retry budget, and a "failed" state should stay failed
  // until the user retries.
  const phaseRef = useRef(state.phase);
  useEffect(() => {
    phaseRef.current = state.phase;
  }, [state.phase]);
  useEffect(() => {
    return subscribeAssistantUnreachable(() => {
      if (phaseRef.current === "idle" && !probingRef.current) {
        if (Date.now() - dismissedAtRef.current > BUS_REENTRY_COOLDOWN_MS) {
          probe({ showConnectingImmediately: false, silentGracePeriod: true });
        }
        return;
      }
      // Allow the bus to re-open the overlay after a previous "ready",
      // but only after a short cooldown so the refetch-503 burst that
      // can arrive right when the pod transitions to ready does not
      // immediately re-trigger a probe cycle (which would make the
      // overlay visibly flicker on/off).
      if (
        phaseRef.current === "ready" &&
        Date.now() - readyAtRef.current > BUS_REENTRY_COOLDOWN_MS
      ) {
        probe({ showConnectingImmediately: false, silentGracePeriod: true });
      }
    });
  }, [probe]);

  return useMemo(
    () => ({ state, probe, reset }),
    [state, probe, reset],
  );
}
