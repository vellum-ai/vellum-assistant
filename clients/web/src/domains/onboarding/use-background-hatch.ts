import { useCallback, useRef, useState } from "react";

import {
  getAssistant,
  getAssistantHealthz,
  hatchAssistant,
} from "@/assistant/api";
import {
  isPlatformHostedDisabled,
  PLATFORM_HOSTED_DISABLED_MESSAGE,
  resolveAssistantLifecycleState,
  shouldRecoverFromHatchFailure,
} from "@/assistant/lifecycle";
import { captureError } from "@/lib/sentry/capture-error";
import { extractErrorMessage } from "@/utils/api-errors";

// Mirrors the poll/backoff constants in
// `@/domains/onboarding/pages/hatching-screen.tsx`. The research-onboarding
// flow kicks this hatch off in the background the moment the user lands on the
// onboarding page, so by the time they finish the intro/pitch steps and submit
// their details the assistant is (usually) already healthy and the flow can
// immediately fire its research turn.
const POLL_INTERVAL_MS = 3000;
const MAX_HATCH_WAIT_MS = 300_000;

const GENERIC_HATCH_ERROR =
  "Failed to start your assistant. Please try again.";
const TIMEOUT_ERROR =
  "Your assistant is taking longer than expected. Please try again.";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface UseBackgroundHatch {
  /** Fire the hatch. Idempotent — only the first call provisions. */
  start: () => void;
  /** True only once the assistant has passed a health check. */
  ready: boolean;
  /** The provisioned assistant id, set once the hatch resolves. */
  assistantId: string | null;
  /** A terminal failure message, or null while healthy / in-flight. */
  error: string | null;
  /** Resolves with the assistant id once ready; rejects on terminal failure. */
  awaitReady: () => Promise<string>;
}

/**
 * Background-hatch primitive for the research-onboarding flow.
 *
 * `start()` is ref-guarded so the hatch fires at most once per hook instance
 * regardless of how many times it's called. The flow reuses the
 * hatching-screen machinery: hatch the managed assistant, poll `getAssistant`
 * until it reports `active`, then poll `getAssistantHealthz` until the daemon
 * is reachable. `ready` only flips after the health check passes — never on
 * the hatch return.
 *
 * Terminal failures (platform-hosted disabled, non-recoverable hatch errors,
 * lifecycle errors, timeout) set `error` and reject `awaitReady()`.
 * Recoverable failures (5xx / network) keep polling.
 */
export function useBackgroundHatch(): UseBackgroundHatch {
  const [ready, setReady] = useState(false);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startedRef = useRef(false);
  // Resolvers for any `awaitReady()` callers waiting on the in-flight hatch.
  const waitersRef = useRef<
    {
      resolve: (id: string) => void;
      reject: (err: Error) => void;
    }[]
  >([]);
  const settledRef = useRef<
    { kind: "ready"; id: string } | { kind: "error"; message: string } | null
  >(null);

  const settleReady = useCallback((id: string) => {
    if (settledRef.current) return;
    settledRef.current = { kind: "ready", id };
    setReady(true);
    for (const w of waitersRef.current) w.resolve(id);
    waitersRef.current = [];
  }, []);

  const settleError = useCallback((message: string) => {
    if (settledRef.current) return;
    settledRef.current = { kind: "error", message };
    setError(message);
    const err = new Error(message);
    for (const w of waitersRef.current) w.reject(err);
    waitersRef.current = [];
  }, []);

  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const startMs = Date.now();
    const timedOut = () => Date.now() - startMs >= MAX_HATCH_WAIT_MS;

    void (async () => {
      // 1. Hatch (managed/platform). 201 = newly created, 200 = existing.
      let hatchedAssistantId: string | undefined;
      try {
        const result = await hatchAssistant();
        if (result.ok) {
          hatchedAssistantId = result.data.id;
          setAssistantId(result.data.id);
        } else {
          if (isPlatformHostedDisabled(result.status, result.error)) {
            settleError(PLATFORM_HOSTED_DISABLED_MESSAGE);
            return;
          }
          if (!shouldRecoverFromHatchFailure(result.status)) {
            settleError(
              extractErrorMessage(result.error, undefined, GENERIC_HATCH_ERROR),
            );
            return;
          }
          // Recoverable — fall through to polling for an existing/active one.
        }
      } catch (err) {
        // Transient/transport failure — recover via polling.
        captureError(err, { context: "research_background_hatch" });
      }

      // 2. Poll until the assistant reports `active`.
      let activeAssistantId: string | undefined;
      while (!activeAssistantId) {
        if (timedOut()) {
          settleError(TIMEOUT_ERROR);
          return;
        }
        try {
          let result = await getAssistant(hatchedAssistantId);
          // A stale hatched id (404) falls back to list-based discovery.
          if (hatchedAssistantId && !result.ok && result.status === 404) {
            hatchedAssistantId = undefined;
            result = await getAssistant();
          }
          const state = resolveAssistantLifecycleState(result);
          if (state.kind === "active" && result.ok) {
            activeAssistantId = result.data.id;
            setAssistantId(activeAssistantId);
            break;
          }
          if (state.kind === "error") {
            settleError(state.message);
            return;
          }
        } catch (err) {
          captureError(err, { context: "research_background_hatch_poll" });
        }
        await sleep(POLL_INTERVAL_MS);
      }

      // 3. Poll healthz until the daemon is reachable, then mark ready.
      while (true) {
        try {
          const health = await getAssistantHealthz(activeAssistantId);
          if (health.ok) break;
        } catch {
          // Daemon not reachable yet.
        }
        if (timedOut()) {
          settleError(TIMEOUT_ERROR);
          return;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      settleReady(activeAssistantId);
    })();
  }, [settleError, settleReady]);

  const awaitReady = useCallback((): Promise<string> => {
    const settled = settledRef.current;
    if (settled?.kind === "ready") return Promise.resolve(settled.id);
    if (settled?.kind === "error") return Promise.reject(new Error(settled.message));
    return new Promise<string>((resolve, reject) => {
      waitersRef.current.push({ resolve, reject });
    });
  }, []);

  return { start, ready, assistantId, error, awaitReady };
}
