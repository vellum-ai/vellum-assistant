
import * as Sentry from "@sentry/react";
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { extractErrorMessage } from "@/utils/api-errors";
import {
  getAssistant,
  hatchAssistant,
  retireAssistantById,
  type GetAssistantResult,
} from "@/assistant/api";
import {
  buildInitializingTimeoutError,
  INITIALIZING_TIMEOUT_MS,
  isPlatformHostedDisabled,
  PLATFORM_HOSTED_DISABLED_MESSAGE,
  resolveAssistantLifecycleState,
  shouldRecoverFromHatchFailure,
} from "@/assistant/lifecycle";
import {
  ASSISTANT_QUERY_KEY,
  POLL_INTERVAL_MS,
  useAssistantQuery,
} from "@/assistant/queries";
import type { AssistantState } from "@/assistant/types";
import { isGatewayAuthMode, getGatewayToken } from "@/lib/auth/gateway-session";
import { getSelectedAssistant, getLocalGatewayUrl, isLocalMode } from "@/lib/local-mode";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";


const MAX_HATCH_RETRIES = 3;
const MAX_INITIALIZING_RECOVERIES = 3;

interface UseAssistantLifecycleOptions {
  isLoggedIn: boolean;
  isLoading: boolean;
  isRetired: boolean;
  isNonProduction: boolean;
  hasPlatformSession: boolean;
  /** Framework-agnostic redirect — called instead of router.replace(). */
  onRedirect: (url: string) => void;
  /**
   * Returns the path to redirect to when onboarding should intercept,
   * or `null` if the intended destination is fine as-is. Injected as
   * an option so this hook stays free of the onboarding domain (the
   * `assistant/` module is shared infrastructure; depending on a
   * domain would invert the `shared → domains` direction).
   */
  resolveOnboardingRedirect: (input: {
    intendedDestination: string;
  }) => string | null;
}

export interface UseAssistantLifecycleReturn {
  assistantState: AssistantState;
  assistantId: string | null;
  setAssistantId: Dispatch<SetStateAction<string | null>>;
  /** Re-check the assistant status from the server. Exposed for the
   *  visibility-change handler and other external effects. */
  checkAssistant: () => Promise<void>;
  /** Reset all retry/recovery counters and re-check. For the error
   *  screen "Try again" button. */
  retryAssistant: () => void;
  /** Reset hatch retries, arm auto-greet, and hatch with the given
   *  version. For the version-selection screen. */
  hatchVersion: (version?: string) => void;
  /** Shared ref — set to `true` when the first post-hatch message
   *  should be an auto-greet. Read by the send-message and
   *  conversation-loader domains. */
  autoGreetRef: MutableRefObject<boolean>;
}

/**
 * Owns the assistant lifecycle state machine: hatching, recovery, and
 * the derived `AssistantState` that drives top-level page rendering.
 *
 * The server-side resource (`/assistant/`) is owned by the
 * `useAssistantQuery` TanStack Query — this hook subscribes to its
 * result and layers a client-side state machine on top:
 *
 *   - Retry budgets that distinguish recoverable 5xx from terminal
 *     errors like the platform-hosted-disabled capacity kill-switch.
 *   - A "stuck initializing" recovery path that retires and re-hatches
 *     an assistant the daemon never promoted to `active`.
 *   - Generation counters that drop responses from a previous recovery
 *     cycle so a slow `getAssistant()` can't revive the spinner after
 *     a timeout already escalated the state to `error`.
 *   - Side effects on lifecycle transitions: priming / clearing the
 *     self-hosted connection, redirecting to onboarding, surfacing
 *     awaiting-version-selection in nonprod.
 *
 * Framework-agnostic — no Next.js or React Router imports. Routing is
 * delegated to the caller via the `onRedirect` callback.
 */
export function useAssistantLifecycle({
  isLoggedIn,
  isLoading,
  isRetired,
  isNonProduction,
  hasPlatformSession,
  onRedirect,
  resolveOnboardingRedirect,
}: UseAssistantLifecycleOptions): UseAssistantLifecycleReturn {
  const [assistantState, setAssistantState] = useState<AssistantState>({
    kind: "loading",
  });
  const [assistantId, setAssistantId] = useState<string | null>(null);

  const hatchingRef = useRef(false);
  const hatchRetryCountRef = useRef(0);
  const initializingAssistantIdRef = useRef<string | null>(null);
  const initializingRecoveryCountRef = useRef(0);
  const hatchingVersionRef = useRef<string | undefined>(undefined);
  const [initializingCycle, setInitializingCycle] = useState(0);
  // Bumped when an "initializing" cycle times out. Async work that captured a
  // prior value compares against this and drops its response, so stale
  // "initializing" answers can't revive the spinner after timeout -> error.
  const initializingGenerationRef = useRef(0);
  const autoGreetRef = useRef(false);

  // Stabilize external values with refs so useCallback identities stay stable.
  const isRetiredRef = useRef(isRetired);
  isRetiredRef.current = isRetired;
  const isNonProductionRef = useRef(isNonProduction);
  isNonProductionRef.current = isNonProduction;
  const onRedirectRef = useRef(onRedirect);
  onRedirectRef.current = onRedirect;
  const resolveOnboardingRedirectRef = useRef(resolveOnboardingRedirect);
  resolveOnboardingRedirectRef.current = resolveOnboardingRedirect;

  const queryClient = useQueryClient();
  // Dumb mutation wrappers — no implicit retry, no Sentry capture.
  // The recovery state machine below owns retry budgets
  // (`MAX_HATCH_RETRIES`, `MAX_INITIALIZING_RECOVERIES`) and stacks
  // hatch + retire across recovery cycles. TanStack Query retrying
  // on top would burn the budget twice as fast and double-log.
  const hatchMutation = useMutation({ mutationFn: hatchAssistant });
  const retireMutation = useMutation({ mutationFn: retireAssistantById });

  // `useMutation` returns a new object reference every render, but the
  // bound `mutateAsync` methods on the underlying observer don't.
  // Capture them in refs so the `useCallback`s below don't have to list
  // an unstable object in their deps array — without this, every render
  // would re-issue `hatchAndCheck` / `checkAssistant` / `recoverStuck...`
  // identities, the init effect would re-fire, and active users would
  // see a continuous `/assistant/` fetch loop.
  const hatchMutateRef = useRef(hatchMutation.mutateAsync);
  hatchMutateRef.current = hatchMutation.mutateAsync;
  const retireMutateRef = useRef(retireMutation.mutateAsync);
  retireMutateRef.current = retireMutation.mutateAsync;

  // Whether to query the server-side status at all. Gateway-auth mode
  // and "local mode without platform session" short-circuit to local
  // states without ever calling /assistant/.
  const shouldQueryServer =
    isLoggedIn &&
    !isLoading &&
    !isGatewayAuthMode() &&
    (hasPlatformSession || !isLocalMode());

  // Background poll + cache writes. Side effects run from the
  // `assistantResult` effect below, not from the query's return
  // shape itself, so the recovery state machine controls when
  // projections fire (only while the lifecycle is transient).
  const { data: assistantResult } = useAssistantQuery({
    enabled: shouldQueryServer,
  });

  /**
   * Imperative re-check. Today the TanStack Query polls in the
   * background while the lifecycle is transient; callers use this for
   * the `app.resume` / visibility-change handler that needs to verify
   * the daemon is still alive immediately on return.
   *
   * Falls back to a direct `getAssistant()` call when the
   * gateway-auth / local-mode short-circuit means the query is
   * disabled. In those modes the lifecycle is local-only and the
   * "re-check" is a no-op refresh of the gateway connection.
   */
  const hatchAndCheck = useCallback(async (version?: string) => {
    if (hatchingRef.current) return;

    if (hatchRetryCountRef.current >= MAX_HATCH_RETRIES) {
      setAssistantState({
        kind: "error",
        message: "Failed to start your assistant after multiple attempts. Please refresh the page to try again.",
      });
      return;
    }

    hatchingRef.current = true;
    hatchingVersionRef.current = version;
    const generation = initializingGenerationRef.current;
    setInitializingCycle((n) => n + 1);
    setAssistantState({ kind: "initializing" });
    try {
      const result = await hatchMutateRef.current(
        version ? { version } : undefined,
      );
      if (generation !== initializingGenerationRef.current) return;
      if (result.ok) {
        initializingAssistantIdRef.current = result.data.id;
        // Seed the assistant-query cache with the hatch response so
        // post-hatch polling actually begins. The initial /assistant/
        // read for a fresh user caches a 404; without this seed,
        // `pollIntervalFor(404)` keeps the query idle and newly-hatched
        // users sit on the initializing screen until the 5-minute
        // stuck-assistant recovery timer fires. The hatch response is
        // shape-compatible with `GetAssistantResult`, so projecting it
        // directly avoids an extra round-trip we don't need.
        queryClient.setQueryData<GetAssistantResult>(ASSISTANT_QUERY_KEY, {
          ok: true,
          status: result.status,
          data: result.data,
        });
      }
      if (!result.ok) {
        hatchRetryCountRef.current += 1;
        Sentry.captureMessage("Hatch request failed", {
          level: "warning",
          extra: { status: result.status, error: result.error, attempt: hatchRetryCountRef.current },
        });
        // Capacity / kill-switch from the backend (platform-hosted-enabled
        // flag is off). Surface the tailored message instead of treating
        // this as a recoverable 5xx — retrying just burns the
        // MAX_HATCH_RETRIES budget and ends in a generic error.
        if (isPlatformHostedDisabled(result.status, result.error)) {
          setAssistantState({
            kind: "error",
            message: PLATFORM_HOSTED_DISABLED_MESSAGE,
          });
          return;
        }
        if (shouldRecoverFromHatchFailure(result.status)) {
          setAssistantState({ kind: "initializing" });
          // Cache is still 404 → `pollIntervalFor` keeps the query
          // idle → no automatic retry. Space the next attempt by
          // `POLL_INTERVAL_MS` to preserve the 3-second backoff
          // between hatch retries: rapid back-to-back invalidations
          // burn the `MAX_HATCH_RETRIES` budget in milliseconds and
          // hammer the server. The invalidation refetch lands the
          // 404 in cache; the cache subscriber re-enters
          // `applyServerStateUpdate` → `auto_hatch` → `hatchAndCheck`
          // against the next retry slot.
          setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: ASSISTANT_QUERY_KEY });
          }, POLL_INTERVAL_MS);
          return;
        }

        setAssistantState({
          kind: "error",
          message: extractErrorMessage(
            result.error,
            undefined,
            "Failed to start your assistant. Please refresh the page to try again.",
          ),
        });
        return;
      }
      hatchRetryCountRef.current = 0;
    } catch (err) {
      hatchRetryCountRef.current += 1;
      Sentry.captureException(err, {
        tags: { context: "hatch_assistant" },
      });
      if (generation !== initializingGenerationRef.current) return;
      setAssistantState({ kind: "initializing" });
      // Network error during hatch behaves like a recoverable failure
      // (cache still 404, no automatic poll). Apply the same
      // 3-second backoff before driving the next attempt.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ASSISTANT_QUERY_KEY });
      }, POLL_INTERVAL_MS);
      return;
    } finally {
      hatchingRef.current = false;
    }
    if (generation !== initializingGenerationRef.current) return;
    // Re-assert "initializing" so the poll loop restarts in case an
    // early poll returned 404 and switched state to "initializing"
    // while the hatch request was still in-flight.
    setAssistantState({ kind: "initializing" });
  }, [queryClient]);

  /**
   * Project a server result onto local lifecycle state + side effects.
   *
   * Splitting this out of `checkAssistant` matters for the cache
   * subscription below: a successful 3-second poll lands the new
   * result in the query cache, the subscription fires, and we want to
   * re-apply the side effects without triggering another network
   * round-trip. Calling `checkAssistant` from the subscription would
   * `fetchQuery({ staleTime: 0 })` again and collapse the polling
   * cadence into a request loop.
   *
   * Imperative re-checks (visibility-change handler, retry button)
   * still go through `checkAssistant`, which forces a fresh fetch and
   * then delegates here.
   */
  const applyServerStateUpdate = useCallback(
    async (result: Awaited<ReturnType<typeof getAssistant>>) => {
      const generation = initializingGenerationRef.current;
      const nextState = resolveAssistantLifecycleState(result);
      if (result.ok && nextState.kind === "initializing") {
        initializingAssistantIdRef.current = result.data.id;
      } else if (nextState.kind !== "initializing") {
        initializingAssistantIdRef.current = null;
      }
      if (nextState.kind === "auto_hatch") {
        // If we just retired, show the retired screen instead of auto-hatching.
        if (isRetiredRef.current) {
          setAssistantState({ kind: "retired" });
          return;
        }
        // New signups without completed onboarding should land on
        // `/onboarding/privacy` before we hatch an assistant for them.
        const onboardingRedirect = resolveOnboardingRedirectRef.current({
          intendedDestination: window.location.pathname,
        });
        if (onboardingRedirect) {
          onRedirectRef.current(onboardingRedirect);
          return;
        }
        // In nonprod, let the user pick a release version before hatching.
        if (isNonProductionRef.current) {
          setAssistantState({ kind: "awaiting_version_selection" });
          return;
        }
        // No assistant exists — auto-hatch using managed credentials
        autoGreetRef.current = true;
        await hatchAndCheck();
        return;
      }

      if (nextState.kind === "active" && result.ok) {
        const mm = result.data.maintenance_mode;
        initializingRecoveryCountRef.current = 0;
        hatchingVersionRef.current = undefined;
        // Drop any stale self-hosted connection: the server says the
        // assistant is now managed-active, so runtime calls belong on
        // the platform and we don't want a leftover token attached to
        // those requests either.
        setSelfHostedConnection(null);
        // Set the assistant id here, before any pod-facing fetch runs.
        // The `init` effect below only fetches conversations once
        // `assistantState.kind === "active"`, and that fetch is what
        // the unreachable-bus interceptor is meant to notice. If we
        // wait until after the conversation list query succeeds to set this,
        // the reachability hook's probe() has no target assistant
        // when the 503 arrives and the connecting overlay never
        // shows.
        setAssistantId(result.data.id);
        setAssistantState({
          kind: "active",
          isLocal: result.data.is_local ?? false,
          maintenanceMode: {
            enabled: mm?.enabled,
          },
        });
        return;
      }

      if (nextState.kind === "self_hosted" && result.ok) {
        initializingRecoveryCountRef.current = 0;
        hatchingVersionRef.current = undefined;
        // Record the user's gateway + actor token so the request
        // interceptor can rewrite runtime-proxied calls to the
        // gateway and attach `Authorization: Bearer`. The slots have
        // to be primed before `assistantId` flips, otherwise the
        // first conversation list fetch races us and hits the
        // platform.
        //
        // Both fields are nullable in the serializer:
        //   - `ingress_url`: an assistant can be `is_local=true`
        //     before its gateway hostname is known. In that case the
        //     URL slot stays null and the platform's proxy view 404s
        //     cleanly — surfaces as the chat error state, just one
        //     HTTP hop sooner.
        //   - `platform_actor_token`: there's a brief window after
        //     hatch where `bootstrap_platform_actor_token` is still
        //     in-flight. In that case the request fires
        //     unauthenticated, the gateway responds 401, and the
        //     chat surface lands on its error state.
        setSelfHostedConnection({
          url: result.data.ingress_url,
          token: result.data.platform_actor_token,
        });
        setAssistantId(result.data.id);
        setAssistantState({ kind: "self_hosted" });
        return;
      }

      if (generation !== initializingGenerationRef.current) return;
      if (nextState.kind !== "active") {
        setAssistantState(nextState);
      }
    },
    [hatchAndCheck],
  );

  /**
   * Resolve gateway-auth mode locally and write the active state.
   *
   * Gateway-auth bypasses `/assistant/` entirely — the gateway issues
   * the session token directly and the local assistant resolution
   * lives in `lib/local-mode`. The mount-time init effect and the
   * imperative `checkAssistant` both short-circuit through this
   * helper, so keep them in lockstep.
   */
  const applyGatewayAuthShortCircuit = useCallback(() => {
    let ingressUrl = window.location.origin;
    let resolvedAssistantId = "self";
    const localGateway = getLocalGatewayUrl();
    if (localGateway) {
      const assistant = getSelectedAssistant();
      ingressUrl = `${window.location.origin}${localGateway}`;
      resolvedAssistantId = assistant?.assistantId ?? resolvedAssistantId;
    }
    setSelfHostedConnection({
      url: ingressUrl,
      token: getGatewayToken(),
    });
    setAssistantId(resolvedAssistantId);
    setAssistantState({ kind: "active", isLocal: true });
  }, []);

  const checkAssistant = useCallback(async () => {
    if (isGatewayAuthMode()) {
      applyGatewayAuthShortCircuit();
      return;
    }
    const generation = initializingGenerationRef.current;
    try {
      // Force a fresh fetch through the query cache. `fetchQuery`
      // updates the cache atomically so any other subscriber
      // (sidebar header, identity panel, etc.) sees the same answer
      // this code path acts on. `staleTime: 0` is required: the app's
      // QueryClient sets a 10s default staleTime for queries, and
      // imperative re-checks (visibility-change return, retry button,
      // onboarding pre-chat verification) must hit the network so a
      // 10s-old cached 404 or initializing result doesn't silently
      // replay. Cache-subscription callers go through
      // `applyServerStateUpdate` directly to avoid the read-back loop.
      const result = await queryClient.fetchQuery({
        queryKey: ASSISTANT_QUERY_KEY,
        queryFn: () => getAssistant(),
        staleTime: 0,
      });
      if (generation !== initializingGenerationRef.current) return;
      await applyServerStateUpdate(result);
    } catch (err) {
      console.error("Error checking assistant status:", err);
      Sentry.captureException(err, {
        tags: { context: "check_assistant" },
      });
      if (generation !== initializingGenerationRef.current) return;
      setAssistantState({
        kind: "error",
        message: "Network error. Please check your connection and try again.",
      });
    }
  }, [applyServerStateUpdate, queryClient]);

  const recoverStuckInitializingAssistant = useCallback(async () => {
    if (initializingRecoveryCountRef.current >= MAX_INITIALIZING_RECOVERIES) {
      initializingGenerationRef.current++;
      setAssistantState(buildInitializingTimeoutError());
      return;
    }

    initializingRecoveryCountRef.current++;
    initializingGenerationRef.current++;
    const generation = initializingGenerationRef.current;

    try {
      let assistantIdToRetire = initializingAssistantIdRef.current;
      if (!assistantIdToRetire) {
        // Force-refresh the cached status. We need to know whether the
        // assistant moved off "initializing" before deciding whether to
        // retire-and-rehatch — a cached 10s-old "initializing" result
        // would mislead the decision into an unnecessary retire.
        const result = await queryClient.fetchQuery({
          queryKey: ASSISTANT_QUERY_KEY,
          queryFn: () => getAssistant(),
          staleTime: 0,
        });
        if (generation !== initializingGenerationRef.current) return;
        if (result.ok && result.data.status === "initializing") {
          assistantIdToRetire = result.data.id;
        } else {
          const nextState = resolveAssistantLifecycleState(result);
          initializingAssistantIdRef.current = null;
          if (nextState.kind === "auto_hatch") {
            await hatchAndCheck(hatchingVersionRef.current);
          } else if (nextState.kind === "active" && result.ok) {
            const mm = result.data.maintenance_mode;
            initializingRecoveryCountRef.current = 0;
            setSelfHostedConnection(null);
            setAssistantId(result.data.id);
            setAssistantState({
              kind: "active",
              isLocal: result.data.is_local ?? false,
              maintenanceMode: {
                enabled: mm?.enabled,
              },
            });
          } else if (nextState.kind === "self_hosted" && result.ok) {
            // Mirror the `self_hosted` branch in `checkAssistant`: an
            // assistant can graduate from `initializing` straight into
            // `is_local: true` once the assistant registers its gateway.
            // Without this branch the recovery path leaves
            // `assistantId` null and the chat surface keeps showing
            // the initializing-timeout error after the assistant has
            // actually come up.
            initializingRecoveryCountRef.current = 0;
            setSelfHostedConnection({
              url: result.data.ingress_url,
              token: result.data.platform_actor_token,
            });
            setAssistantId(result.data.id);
            setAssistantState({ kind: "self_hosted" });
          } else {
            if (nextState.kind !== "active") {
              setAssistantState(nextState);
            }
          }
          return;
        }
      }

      // Prevent the poll loop from calling hatchAndCheck() while we retire
      // the stuck assistant. Without this, a poll that observes the 404 (after
      // the retire takes effect on the backend but before our own hatchAndCheck
      // creates the replacement) races to create a duplicate assistant.
      hatchingRef.current = true;

      const retireResult = await retireMutateRef.current(assistantIdToRetire);
      if (generation !== initializingGenerationRef.current) {
        hatchingRef.current = false;
        return;
      }
      if (!retireResult.ok && retireResult.status !== 404) {
        hatchingRef.current = false;
        Sentry.captureMessage("Failed to retire stuck initializing assistant", {
          level: "warning",
          extra: { status: retireResult.status, error: retireResult.error },
        });
        setAssistantState(buildInitializingTimeoutError());
        return;
      }

      initializingAssistantIdRef.current = null;
      setAssistantId(null);
      hatchingRef.current = false;
      await hatchAndCheck(hatchingVersionRef.current);
    } catch (err) {
      hatchingRef.current = false;
      Sentry.captureException(err, {
        tags: { context: "recover_stuck_initializing_assistant" },
      });
      if (generation !== initializingGenerationRef.current) return;
      setAssistantState(buildInitializingTimeoutError());
    }
  }, [hatchAndCheck, queryClient]);

  // Local-mode: gateway token and connection are primed during onboarding hatch.
  useEffect(() => {
    if (!isLoggedIn || isLoading) {
      return;
    }
    // Gateway auth takes priority over the platform session path below.
    // In local mode after hatch, this branch is the entry point.
    if (isGatewayAuthMode()) {
      applyGatewayAuthShortCircuit();
      return;
    }
    // In local mode without a gateway token AND no platform session,
    // the platform API isn't available — redirect to onboarding.
    // If the user logged in and chose Vellum Cloud, hasPlatformSession
    // is true and we fall through to checkAssistant() below.
    if (isLocalMode() && !isGatewayAuthMode() && !hasPlatformSession) {
      const redirect = resolveOnboardingRedirectRef.current({ intendedDestination: window.location.pathname });
      if (redirect) {
        onRedirectRef.current(redirect);
      }
      return;
    }
    if (hasPlatformSession) {
      setSelfHostedConnection(null);
      checkAssistant();
      return;
    }
    checkAssistant();
  }, [isLoggedIn, isLoading, hasPlatformSession, checkAssistant, applyGatewayAuthShortCircuit]);

  // While the lifecycle is transient (`initializing` / `cleaning_up`),
  // project each new query result into local state. The query polls
  // on the 3-second cadence defined by `pollIntervalFor`; `data`
  // updates as each successful poll (or hatch-time `setQueryData`
  // seed, or `invalidateQueries` refetch) lands in cache. When the
  // lifecycle is stable, the query stops polling, this effect's
  // dependencies stop changing, and nothing projects — preserving
  // the original "stop reacting once we land somewhere stable"
  // contract that the old polling loop had via its early return.
  useEffect(() => {
    if (
      assistantState.kind !== "initializing" &&
      assistantState.kind !== "cleaning_up"
    ) {
      return;
    }
    if (!assistantResult) return;
    void applyServerStateUpdate(assistantResult);
  }, [assistantResult, assistantState.kind, applyServerStateUpdate]);

  // If the backend assigns an assistant but never promotes it to "active",
  // retire that stuck row and hatch a replacement.
  useEffect(() => {
    if (assistantState.kind !== "initializing") {
      return;
    }
    const timeout = setTimeout(() => {
      Sentry.captureMessage("Assistant hatch stuck in initializing state", {
        level: "warning",
        extra: { timeoutMs: INITIALIZING_TIMEOUT_MS },
      });
      void recoverStuckInitializingAssistant();
    }, INITIALIZING_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [assistantState.kind, initializingCycle, recoverStuckInitializingAssistant]);

  const retryAssistant = useCallback(() => {
    hatchRetryCountRef.current = 0;
    initializingRecoveryCountRef.current = 0;
    checkAssistant();
  }, [checkAssistant]);

  const hatchVersion = useCallback((version?: string) => {
    hatchRetryCountRef.current = 0;
    autoGreetRef.current = true;
    hatchAndCheck(version);
  }, [hatchAndCheck]);

  return {
    assistantState,
    assistantId,
    setAssistantId,
    checkAssistant,
    retryAssistant,
    hatchVersion,
    autoGreetRef,
  };
}
