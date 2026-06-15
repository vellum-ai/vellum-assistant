import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

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
import { seedHatchAvatar } from "@/assistant/seed-hatch-avatar";
import { captureError } from "@/lib/sentry/capture-error";
import { extractErrorMessage } from "@/utils/api-errors";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { randomCharacterTraits } from "@/utils/avatar-random";
import type { CharacterTraits } from "@/types/avatar";

// Mirrors the poll/backoff constants in
// `@/domains/onboarding/pages/hatching-screen.tsx`. The cast onboarding flow
// kicks this hatch off in the background while the user is still filling out
// the occupation/role step, so by the time they submit the assistant is
// (usually) already healthy and the flow can immediately send its first
// research directive.
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
 * Background-hatch primitive for the cast onboarding flow.
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
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startedRef = useRef(false);
  // Set on unmount so the poll loop bails instead of running to the 5-min
  // timeout — mirrors the `cancelled` flag in `hatching-screen.tsx`. A
  // retry-remount would otherwise leave a stale loop polling in the background.
  const cancelledRef = useRef(false);
  // Random hatch traits, generated once per instance via a lazy state
  // initializer (matching the standalone hatching screen) so a cast-hatched
  // assistant lands with a seeded avatar.
  const [hatchTraits] = useState<CharacterTraits>(() =>
    randomCharacterTraits(BUNDLED_COMPONENTS),
  );
  // Resolvers for any `awaitReady()` callers waiting on the in-flight hatch.
  const waitersRef = useRef<{
    resolve: (id: string) => void;
    reject: (err: Error) => void;
  }[]>([]);
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
      // A 201 means a brand-new assistant — seedable with a random avatar (the
      // same signal `hatching-screen.tsx` uses). A 200 returned an existing
      // assistant, whose avatar must not be clobbered.
      let createdFreshAssistant = false;
      try {
        const result = await hatchAssistant();
        if (cancelledRef.current) return;
        if (result.ok) {
          hatchedAssistantId = result.data.id;
          setAssistantId(result.data.id);
          createdFreshAssistant = result.status === 201;
        } else {
          if (isPlatformHostedDisabled(result.status, result.error)) {
            settleError(PLATFORM_HOSTED_DISABLED_MESSAGE);
            return;
          }
          if (!shouldRecoverFromHatchFailure(result.status)) {
            settleError(
              extractErrorMessage(
                result.error,
                undefined,
                GENERIC_HATCH_ERROR,
              ),
            );
            return;
          }
          // Recoverable — fall through to polling for an existing/active one.
        }
      } catch (err) {
        // Transient/transport failure — recover via polling.
        captureError(err, { context: "cast_background_hatch" });
      }

      // 2. Poll until the assistant reports `active`.
      let activeAssistantId: string | undefined;
      while (!activeAssistantId) {
        if (cancelledRef.current) return;
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
          captureError(err, { context: "cast_background_hatch_poll" });
        }
        await sleep(POLL_INTERVAL_MS);
      }

      // Fire-and-forget — readiness never blocks on the avatar render.
      if (createdFreshAssistant) {
        void seedHatchAvatar(activeAssistantId, hatchTraits, queryClient);
      }

      // 3. Poll healthz until the daemon is reachable, then mark ready.
      while (true) {
        if (cancelledRef.current) return;
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
  }, [hatchTraits, queryClient, settleError, settleReady]);

  // Cancel the poll loop on unmount so a retry-remount doesn't leave a stale
  // loop running to the 5-min timeout. Effect cleanup runs on unmount only
  // (empty deps), mirroring the hatching-screen's `cancelled` teardown.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

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
