import * as Sentry from "@sentry/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

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
import {
  awaitPurchasedProvisioning,
  MAX_HATCH_WAIT_MS,
  POLL_INTERVAL_MS,
} from "@/domains/onboarding/purchased-provisioning";
import {
  getOrgHeaderReadiness,
  ORG_HEADER_SETTLE_TIMEOUT_MS,
} from "@/hooks/use-is-org-ready";
import { clearGatewayToken } from "@/lib/auth/gateway-session";
import {
  getLockfileAssistant,
  isLocalClient,
  probeLocalGatewayReady,
  saveManagedLockfileAssistant,
} from "@/lib/local-mode";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { captureError } from "@/lib/sentry/capture-error";
import {
  getActiveOrganizationIdForRequests,
  useOrganizationStore,
} from "@/stores/organization-store";
import { extractErrorMessage } from "@/utils/api-errors";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { randomCharacterTraits } from "@/utils/avatar-random";

const GENERIC_HATCH_ERROR = "Failed to start your assistant. Please try again.";
const TIMEOUT_ERROR =
  "Your assistant is taking longer than expected. Please try again.";
const ORG_HEADER_ERROR =
  "We couldn't confirm your organization. Please try again.";
// Cadence for the org-header wait. Tighter than the assistant poll: the store
// hydrates in one round trip, so every tick is dead time before the hatch POST.
const ORG_HEADER_POLL_INTERVAL_MS = 100;

export interface UseBackgroundHatch {
  /** Fire the hatch. Idempotent — only the first call provisions. */
  start: () => void;
  /**
   * Re-run a failed hatch from the top, clearing the terminal state first.
   * `awaitReady()` waiters from the failed attempt were already rejected at
   * `settleError` time, so callers must re-await after retrying.
   */
  retry: () => void;
  /** True only once the assistant has passed a health check. */
  ready: boolean;
  /** The provisioned assistant id, set once the hatch resolves. */
  assistantId: string | null;
  /** A terminal failure message, or null while healthy / in-flight. */
  error: string | null;
  /** Resolves with the assistant id once ready; rejects on terminal failure. */
  awaitReady: () => Promise<string>;
}

export interface UseBackgroundHatchOptions {
  /**
   * Adopt an assistant that was ALREADY provisioned in the foreground (the
   * local-hosting path: hosting pick → hatching screen → local daemon), instead
   * of running the managed `hatchAssistant()` here. When true we skip step 1 and
   * discover that live assistant via `getAssistant()`.
   *
   * This must NOT be conflated with `isLocalClient()` (a build-time value): the
   * desktop app runs in local mode but can still onboard a Vellum-Cloud
   * (managed) assistant, which needs the managed hatch. Derive this from the
   * chosen HOSTING, not the build (see the research route's `?hosting` read).
   */
  adoptExisting?: boolean;
  /**
   * The id of the assistant to adopt (the one the hatching screen just
   * provisioned), carried through the research redirect. Pins discovery to
   * that exact assistant so a stale selection or leftover lockfile entries
   * from previous sessions can't answer for it. When omitted (or the id turns
   * out stale), discovery falls back to the selected/active assistant.
   */
  adoptAssistantId?: string;
  /**
   * The hatch is the return leg of a completed checkout (`post_checkout=1`):
   * after healthz, hold `ready` until the purchased machine/storage resize
   * converges (`awaitPurchasedProvisioning`), then re-probe healthz. Never set
   * on the free path — the free hatch must not add subscription polling.
   */
  postCheckoutReturn?: boolean;
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
 * When `adoptExisting` is set (a local-hosting onboarding), the managed hatch is
 * skipped and we adopt the already-live assistant instead. When
 * `postCheckoutReturn` is set, `ready` additionally waits on the purchased
 * machine/storage resize so the paid user never starts on a baseline assistant.
 *
 * Terminal failures (platform-hosted disabled, non-recoverable hatch errors,
 * lifecycle errors, timeout) set `error` and reject `awaitReady()`.
 * Recoverable failures (5xx / network) keep polling.
 *
 * Unmounting aborts the sequence — see `abortedRef`.
 */
export function useBackgroundHatch({
  adoptExisting = false,
  adoptAssistantId,
  postCheckoutReturn = false,
}: UseBackgroundHatchOptions = {}): UseBackgroundHatch {
  const queryClient = useQueryClient();
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
  // The hatch sequence outlives a render by minutes (a 90s purchased-resize
  // hold, a 300s health poll), so unmount has to stop it: an aborted hatch
  // refuses to settle, every loop and the provisioning wait check this, sleeps
  // resolve immediately, and the pending poll timer is cleared.
  const abortedRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set by `retry()`, so the org-header wait can tell a user-driven second
  // attempt from the first one. See `awaitOrgHeader`.
  const retriedRef = useRef(false);

  useEffect(() => {
    // Reset on (re)mount so StrictMode's simulated unmount doesn't abort the
    // hatch its own second mount is about to keep running.
    abortedRef.current = false;
    return () => {
      abortedRef.current = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const settleReady = useCallback((id: string) => {
    if (abortedRef.current || settledRef.current) {
      return;
    }
    settledRef.current = { kind: "ready", id };
    setReady(true);
    for (const w of waitersRef.current) {
      w.resolve(id);
    }
    waitersRef.current = [];
  }, []);

  const settleError = useCallback((message: string) => {
    if (abortedRef.current || settledRef.current) {
      return;
    }
    settledRef.current = { kind: "error", message };
    setError(message);
    const err = new Error(message);
    for (const w of waitersRef.current) {
      w.reject(err);
    }
    waitersRef.current = [];
  }, []);

  const start = useCallback(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    const isRetryAttempt = retriedRef.current;
    const startMs = Date.now();
    const timedOut = () => Date.now() - startMs >= MAX_HATCH_WAIT_MS;
    // Parks the pending handle so unmount can clear it. Once aborted the wait
    // resolves without scheduling anything, so the loop reaches its next check
    // with no timer left behind.
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        if (abortedRef.current) {
          resolve();
          return;
        }
        pollTimerRef.current = setTimeout(() => {
          pollTimerRef.current = null;
          resolve();
        }, ms);
      });

    // Every platform request below is scoped by `Vellum-Organization-Id`, which
    // the interceptor reads from the org store — and that store hydrates after
    // auth. A checkout deep link can relaunch the app straight into this hook
    // before hydration lands (no list yet, no persisted id either), where a
    // header-less hatch is rejected and a paying user meets the failure banner.
    //
    // Resolves true once the header source can answer, which on a warm store is
    // the first synchronous check. False means the sequence must stop: aborted,
    // or settled without an id — terminal but retryable, since `retry()` re-runs
    // this wait.
    //
    // Each attempt re-triggers resolution once so "Try again" has something new
    // to wait on. Resolution that already concluded without an id gets that kick
    // on any attempt: nothing else is coming. Resolution still in flight only
    // gets it on a RETRY — a first attempt must not race the store's own
    // cold-boot hydration, but by the time the user presses "Try again" a fetch
    // still pending past the ceiling is a stalled request, and the store neither
    // times out nor dedupes, so a fresh one supersedes it. Without that, every
    // retry re-runs the same timeout and the hatch can't recover from a hung
    // request even after connectivity returns.
    const awaitOrgHeader = async (): Promise<boolean> => {
      const waitStartMs = Date.now();
      let refetched = false;
      while (true) {
        if (abortedRef.current) {
          return false;
        }
        const readiness = getOrgHeaderReadiness();
        if (readiness === "ready") {
          return true;
        }
        if (!refetched && (readiness === "unavailable" || isRetryAttempt)) {
          refetched = true;
          void useOrganizationStore.getState().fetchOrganizations();
        } else if (
          readiness === "unavailable" ||
          Date.now() - waitStartMs >= ORG_HEADER_SETTLE_TIMEOUT_MS
        ) {
          settleError(ORG_HEADER_ERROR);
          return false;
        }
        await sleep(ORG_HEADER_POLL_INTERVAL_MS);
      }
    };

    void (async () => {
      // 0. Adopt straight from the lockfile when the handed-off id resolves.
      //
      // The hatching screen provisioned this assistant in the FOREGROUND and
      // polled the local gateway's readyz before navigating here, so a live
      // lockfile entry for the handed-off id means there is nothing left to
      // discover or wait for — adopt it as ready outright. Re-running
      // discovery (platform getAssistant + gateway probe) is not just wasted
      // work: at mount the gateway token / selection may not be observable
      // yet, in which case getAssistant misses its lockfile short-circuit and
      // polls the PLATFORM for an assistant that only exists locally,
      // stranding the flow on the "Waking up" gate until timeout. A stale id
      // (retired between the handoff and here) has no lockfile entry and
      // falls through to the discovery + readyz path below.
      if (adoptExisting && adoptAssistantId) {
        const adopted = getLockfileAssistant(adoptAssistantId);
        if (adopted) {
          setAssistantId(adopted.assistantId);
          settleReady(adopted.assistantId);
          return;
        }
      }

      // 1. Hatch (managed/platform). 201 = newly created, 200 = existing.
      //
      // A local-hosting onboarding skips this: the assistant is provisioned in
      // the FOREGROUND by the hatching screen (hosting pick → local daemon)
      // BEFORE the research flow mounts, so there's nothing to hatch here. We
      // fall straight through to step 2, which discovers that already-active
      // assistant via getAssistant(). Running the managed `hatchAssistant()`
      // there would provision a SECOND (managed) assistant. Vellum-Cloud
      // onboarding (adoptExisting=false) still runs the managed hatch, even
      // though the desktop build reports `isLocalClient()` — that's why this keys
      // on the chosen hosting, not the build.
      // When adopting, seed discovery with the id the hatching screen handed
      // off, so step 2 resolves that exact assistant (a stale id falls back to
      // list-based discovery via the 404 net below).
      let hatchedAssistantId: string | undefined = adoptExisting
        ? adoptAssistantId
        : undefined;
      if (!adoptExisting) {
        // Hold the whole platform sequence — hatch, discovery, the purchased
        // resize — until the org header can be attached.
        if (!(await awaitOrgHeader())) {
          return;
        }
        // A managed hatch in a local-mode build must address the platform, not
        // the machine's own gateway: `getAssistant()` answers from the selected
        // lockfile entry while a gateway token is held, and daemon SDK calls
        // (the healthz probe below, and the research/personality writes that
        // follow) rewrite to the local gateway while a self-hosted connection
        // is primed. Same handoff the hatching screen performs for its managed
        // path. Both are module-level writes — idempotent under `retry()`, and
        // no auth/org store slice moves, so nothing remounts this hook.
        if (isLocalClient()) {
          clearGatewayToken();
          setSelfHostedConnection(null);
        }
        try {
          const result = await hatchAssistant();
          if (result.ok) {
            hatchedAssistantId = result.data.id;
            setAssistantId(result.data.id);
            // Dock and tray icons are avatar-driven, so a freshly created (201)
            // assistant gets seeded traits. Paid-only: the free hatch makes no
            // avatar write. Fire-and-forget; the research face step overwrites.
            if (postCheckoutReturn && result.status === 201) {
              void seedHatchAvatar(
                result.data.id,
                randomCharacterTraits(BUNDLED_COMPONENTS),
                queryClient,
              );
            }
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
          captureError(err, { context: "research_background_hatch" });
        }
      }

      // 2. Poll until the assistant reports `active`.
      let activeAssistantId: string | undefined;
      while (!activeAssistantId) {
        if (abortedRef.current) {
          return;
        }
        if (timedOut()) {
          settleError(TIMEOUT_ERROR);
          return;
        }
        try {
          let result = await getAssistant(hatchedAssistantId);
          // Re-checked after every await here, not just at the loop head: the
          // branch below writes the lockfile — which sets the ACTIVE assistant
          // — and that write is not guarded by `settleReady`.
          if (abortedRef.current) {
            return;
          }
          // A stale hatched id (404) falls back to list-based discovery.
          if (hatchedAssistantId && !result.ok && result.status === 404) {
            hatchedAssistantId = undefined;
            result = await getAssistant();
            if (abortedRef.current) {
              return;
            }
          }
          const state = resolveAssistantLifecycleState(result);
          if (state.kind === "active" && result.ok) {
            activeAssistantId = result.data.id;
            setAssistantId(activeAssistantId);
            // Desktop-only: the list and switcher read the lockfile. An adopted
            // assistant is already the hatching screen's own write.
            if (!adoptExisting && isLocalClient()) {
              void saveManagedLockfileAssistant(
                activeAssistantId,
                result.data.name,
                getActiveOrganizationIdForRequests() ?? undefined,
              );
            }
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

      // 3. Poll until the assistant's runtime is reachable, then mark ready.
      //
      // Adopting a local assistant checks the LOCAL gateway's `/readyz`
      // (gateway + upstream daemon) — the assistant-scoped
      // `getAssistantHealthz()` SDK call doesn't resolve against a local
      // gateway (it needs a guardian-token-authed
      // `/v1/assistants/{id}/healthz`), so it would spin to the timeout on a
      // healthy assistant. The readyz check matters even though the hatching
      // screen polls it before handing off: an adopt can also start from a
      // session-based fallback (refresh / direct visit with no query string),
      // where a cached gateway token proves nothing about the gateway process
      // still being alive.
      if (adoptExisting) {
        while (!(await probeLocalGatewayReady())) {
          if (abortedRef.current) {
            return;
          }
          if (timedOut()) {
            settleError(TIMEOUT_ERROR);
            return;
          }
          await sleep(POLL_INTERVAL_MS);
        }
      } else {
        while (true) {
          if (abortedRef.current) {
            return;
          }
          try {
            const health = await getAssistantHealthz(activeAssistantId);
            if (health.ok) {
              break;
            }
          } catch {
            // Daemon not reachable yet.
          }
          if (timedOut()) {
            settleError(TIMEOUT_ERROR);
            return;
          }
          await sleep(POLL_INTERVAL_MS);
        }
      }

      // 4. On a paid return, hold `ready` until the purchased resize converges.
      //
      // `managedHatch` is true by construction: the checkout destination always
      // carries `hosting=vellum-cloud`, and `adoptExisting` already excludes the
      // local foreground hatch.
      if (!adoptExisting && postCheckoutReturn) {
        const outcome = await awaitPurchasedProvisioning({
          assistantId: activeAssistantId,
          postCheckoutReturn,
          managedHatch: true,
          hatchStartMs: startMs,
          isCancelled: () => abortedRef.current,
          registerTimer: (timer) => {
            pollTimerRef.current = timer;
          },
        });
        // A cancellation landing mid-healthz past the deadline also reports
        // `"health_timeout"`, and nobody is waiting on this hatch any more —
        // reporting it would be a false alarm.
        if (abortedRef.current) {
          return;
        }
        if (outcome === "health_timeout") {
          // The assistant never answered healthz after the resize; completing
          // would hand the user an unreachable assistant.
          Sentry.captureMessage("Onboarding hatch wait exceeded timeout", {
            level: "warning",
            extra: {
              maxWaitMs: MAX_HATCH_WAIT_MS,
              stage: "post_resize_health",
            },
          });
          settleError(TIMEOUT_ERROR);
          return;
        }
      }

      settleReady(activeAssistantId);
    })();
  }, [
    settleError,
    settleReady,
    adoptExisting,
    adoptAssistantId,
    postCheckoutReturn,
    queryClient,
  ]);

  const retry = useCallback(() => {
    retriedRef.current = true;
    startedRef.current = false;
    settledRef.current = null;
    setError(null);
    setReady(false);
    setAssistantId(null);
    start();
  }, [start]);

  const awaitReady = useCallback((): Promise<string> => {
    const settled = settledRef.current;
    if (settled?.kind === "ready") {
      return Promise.resolve(settled.id);
    }
    if (settled?.kind === "error") {
      return Promise.reject(new Error(settled.message));
    }
    return new Promise<string>((resolve, reject) => {
      waitersRef.current.push({ resolve, reject });
    });
  }, []);

  return { start, retry, ready, assistantId, error, awaitReady };
}
