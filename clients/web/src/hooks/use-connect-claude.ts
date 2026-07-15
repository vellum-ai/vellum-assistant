import { useCallback, useEffect, useRef, useState } from "react";

import { openUrlInNewTab } from "@/runtime/browser";
import {
  exchangeConnectClaude,
  pollConnectClaudeStatus,
  startConnectClaude,
  type ConnectClaudeMode,
} from "./connect-claude-api";

/**
 * Drives the "Connect Claude Code" ACP OAuth flow. Two shapes:
 *   loopback (local/desktop): open the authorize URL, then poll until the
 *     daemon captures the token on its loopback callback.
 *   manual   (cloud):         open the authorize URL, then let the user paste
 *     the `code#state` the redirect page renders for the daemon to exchange.
 *
 * Exported standalone so PR 8 can render an inline Connect affordance when an
 * ACP spawn fails for a missing token.
 */
export type ConnectClaudePhase =
  | "idle"
  | "starting"
  // loopback: browser opened, waiting for the token to land on the callback.
  | "awaiting_capture"
  // manual/cloud: waiting for the user to paste the `code#state`.
  | "awaiting_paste"
  | "exchanging"
  | "connected"
  | "error";

const POLL_INTERVAL_MS = 2000;
// ~5 min of polling, comfortably inside the daemon's 10-min pending-flow TTL.
const MAX_POLL_ATTEMPTS = 150;

export interface UseConnectClaudeResult {
  phase: ConnectClaudePhase;
  mode: ConnectClaudeMode | null;
  error: string | null;
  /** A network/flow op is in flight (start, loopback poll, or exchange). */
  isBusy: boolean;
  /** Start the flow: open the browser, then poll (loopback) or await a paste. */
  connect: () => Promise<void>;
  /** Manual/cloud path: exchange a pasted `code#state` (or a raw code). */
  submitPastedCode: (pasted: string) => Promise<void>;
  /** Return to the initial state so the user can connect again. */
  reset: () => void;
}

export function useConnectClaude(assistantId: string): UseConnectClaudeResult {
  const [phase, setPhase] = useState<ConnectClaudePhase>("idle");
  const [mode, setMode] = useState<ConnectClaudeMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped on every reset / new connect and on unmount, so a stale poll loop
  // from an abandoned flow can't write state after the user restarts.
  const flowIdRef = useRef(0);
  const mountedRef = useRef(true);
  const stateRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flowIdRef.current++;
    };
  }, []);

  const isStale = useCallback(
    (flowId: number) => flowIdRef.current !== flowId || !mountedRef.current,
    [],
  );

  const pollUntilSettled = useCallback(
    async (flowId: number, state: string) => {
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (isStale(flowId)) {
          return;
        }
        let result;
        try {
          result = await pollConnectClaudeStatus(assistantId, state);
        } catch {
          continue; // Transient poll error — keep trying within the budget.
        }
        if (isStale(flowId)) {
          return;
        }
        if (result.status === "connected") {
          setPhase("connected");
          return;
        }
        if (result.status === "error") {
          setError(
            result.error ?? "Connecting Claude failed. Please try again.",
          );
          setPhase("error");
          return;
        }
      }
      setError("Timed out waiting for Claude to connect. Please try again.");
      setPhase("error");
    },
    [assistantId, isStale],
  );

  const connect = useCallback(async () => {
    const flowId = ++flowIdRef.current;
    setError(null);
    setMode(null);
    setPhase("starting");

    let start;
    try {
      start = await startConnectClaude(assistantId);
    } catch {
      if (isStale(flowId)) {
        return;
      }
      setError("Couldn't start Connect Claude. Please try again.");
      setPhase("error");
      return;
    }
    if (isStale(flowId)) {
      return;
    }

    stateRef.current = start.state;
    setMode(start.mode);

    // Open the sign-in page in a new tab; both paths keep this tab mounted (the
    // loopback poll and the manual paste each need it, and same-tab navigation
    // would unload it). On the web a slow `start` can outlast the click's
    // activation and the browser blocks the pop-up — surface a retry rather than
    // advancing to a wait for a tab that never opened. Electron/native open
    // externally and never block, so `opened` is always true there.
    const opened = await openUrlInNewTab(start.authorize_url);
    if (isStale(flowId)) {
      return;
    }
    if (!opened) {
      setError(
        "Your browser blocked the sign-in tab. Allow pop-ups for this site, then click Connect again.",
      );
      setPhase("error");
      return;
    }

    if (start.mode === "loopback") {
      // Loopback/desktop: the daemon captures the token on its own callback; this
      // tab polls for the connected state.
      setPhase("awaiting_capture");
      void pollUntilSettled(flowId, start.state);
    } else {
      // Manual/cloud: the user pastes the `code#state` back into this surface.
      setPhase("awaiting_paste");
    }
  }, [assistantId, isStale, pollUntilSettled]);

  const submitPastedCode = useCallback(
    async (pasted: string) => {
      const trimmed = pasted.trim();
      if (!trimmed) {
        setError("Paste the code shown on the Claude page.");
        return;
      }
      const state = stateRef.current;
      if (!state) {
        setError("Start the Connect Claude flow first.");
        return;
      }
      const flowId = flowIdRef.current;
      setError(null);
      setPhase("exchanging");
      try {
        // The daemon splits a pasted `code#state`; passing the tracked `state`
        // too lets a raw code (no `#`) resolve as well.
        await exchangeConnectClaude(assistantId, trimmed, state);
      } catch {
        if (isStale(flowId)) {
          return;
        }
        setError(
          "Couldn't complete Connect Claude. Check the pasted code and try again.",
        );
        setPhase("awaiting_paste");
        return;
      }
      if (isStale(flowId)) {
        return;
      }
      setPhase("connected");
    },
    [assistantId, isStale],
  );

  const reset = useCallback(() => {
    flowIdRef.current++;
    stateRef.current = null;
    setMode(null);
    setError(null);
    setPhase("idle");
  }, []);

  const isBusy =
    phase === "starting" ||
    phase === "awaiting_capture" ||
    phase === "exchanging";

  return { phase, mode, error, isBusy, connect, submitPastedCode, reset };
}
