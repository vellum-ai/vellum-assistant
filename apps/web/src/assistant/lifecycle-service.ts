/**
 * Assistant lifecycle state machine — the non-React core.
 *
 * Owns: hatching, recovery, retry budgets, the generation counter
 * that drops stale async responses on timeout escalations, the
 * 5-minute stuck-initializing watchdog, the gateway-auth
 * short-circuit, post-hatch cache seeding, and the
 * onboarding-redirect coordination.
 *
 * Publishes its observable state — `assistantState` and
 * `activeAssistantId` — into the two Zustand stores
 * (`useAssistantLifecycleStore`, `useResolvedAssistantsStore`),
 * which is how the React tree reads it. Inputs from React (auth,
 * env, the navigate callback, the TanStack Query client) flow in
 * through `setInputs()`; `useAssistantLifecycle` is the thin
 * wiring layer that pushes them.
 *
 * Module-level singleton — instantiated at import, survives every
 * mount/unmount cycle. Tests can swap in a fresh instance via
 * `__resetForTesting`.
 */

import * as Sentry from "@sentry/react";
import { captureError } from "@/lib/sentry/capture-error";
import type { QueryClient } from "@tanstack/react-query";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
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
  assistantQueryKey,
  POLL_INTERVAL_MS,
} from "@/assistant/queries";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { AssistantState } from "@/assistant/types";
import { extractErrorMessage } from "@/utils/api-errors";
import { isGatewayAuthMode, getGatewayToken } from "@/lib/auth/gateway-session";
import {
  getSelectedAssistant,
  getLocalGatewayUrl,
  isLocalMode,
} from "@/lib/local-mode";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { isAuthenticated, type SessionStatus } from "@/stores/session-status";

const MAX_HATCH_RETRIES = 3;
const MAX_INITIALIZING_RECOVERIES = 3;

export interface LifecycleServiceInputs {
  sessionStatus: SessionStatus;
  isRetired: boolean;
  hasPlatformSession: boolean;
  /** Framework-agnostic redirect — called instead of router.replace(). */
  onRedirect: (url: string) => void;
  /**
   * Returns the path to redirect to when onboarding should intercept,
   * or `null` if the intended destination is fine as-is. Injected so
   * `assistant/` stays free of the onboarding domain (the
   * `shared → domains` direction).
   */
  resolveOnboardingRedirect: (input: {
    intendedDestination: string;
  }) => string | null;
  /** The TanStack Query client owned by `RootLayout`'s provider. */
  queryClient: QueryClient;
  /**
   * The platform assistant the user has selected (multi-assistant). `null`
   * resolves the default first-listed assistant — the pre-multi-assistant
   * behavior. Optional so existing `setInputs` callers/tests need no change.
   */
  selectedPlatformAssistantId?: string | null;
  /**
   * Whether the org store has hydrated (or no platform session exists).
   * Platform API calls require the Vellum-Organization-Id header;
   * `respondToInputs` defers `checkAssistant` until this is true.
   * Mirrors `useIsOrgReady()` from the React layer.
   */
  isOrgReady?: boolean;
}

const NOOP_REDIRECT = (_: string) => {};
const NOOP_RESOLVE: LifecycleServiceInputs["resolveOnboardingRedirect"] =
  () => null;

class AssistantLifecycleService {
  private state: AssistantState = { kind: "loading" };
  private hatching = false;
  private hatchRetryCount = 0;
  private initializingAssistantId: string | null = null;
  private initializingRecoveryCount = 0;
  private hatchingVersion: string | undefined = undefined;
  /**
   * Bumped when an `initializing` cycle times out. Async work that
   * captured a prior value compares against this and drops its
   * response, so stale `initializing` answers can't revive the
   * spinner after timeout → error.
   */
  private generation = 0;
  private initializingTimeout: ReturnType<typeof setTimeout> | null = null;
  /**
   * Public action methods early-return until `setInputs()` flips
   * this true. Without the guard, a child route's `useEffect`
   * calling e.g. `lifecycleService.checkAssistant()` BEFORE
   * `RootLayout`'s passive effect installs the `queryClient` would
   * catch a TypeError on `null.fetchQuery` and publish a spurious
   * network-error state — children's effects commit before
   * parents' in the same render cycle.
   */
  private ready = false;
  private inputs: LifecycleServiceInputs = {
    sessionStatus: "initializing",
    isRetired: false,
    hasPlatformSession: false,
    onRedirect: NOOP_REDIRECT,
    resolveOnboardingRedirect: NOOP_RESOLVE,
    queryClient: null as unknown as QueryClient,
    selectedPlatformAssistantId: null,
  };

  // ---------------------------------------------------------------------------
  // React-facing API
  // ---------------------------------------------------------------------------

  setInputs(inputs: LifecycleServiceInputs): void {
    this.inputs = inputs;
    this.ready = true;
  }

  /**
   * Synchronously drop the selection + lifecycle state. Called from
   * `auth-store.logout()` before `sessionStatus` leaves `authenticated`,
   * so subscribers to either store don't observe a stale id in their
   * first re-render after logout. The `respondToInputs` not-authenticated
   * branch is the safety net for cases where auth flips without
   * going through the explicit logout call (e.g. token expiry
   * detected by an interceptor and surfaced as a state change
   * rather than an action).
   *
   * Guarded resets avoid spurious subscriber wake-ups when the
   * stores are already at defaults.
   */
  resetForLogout(): void {
    if (useResolvedAssistantsStore.getState().activeAssistantId !== null) {
      useResolvedAssistantsStore.getState().setActiveAssistantId(null);
    }
    if (this.state.kind !== "loading") {
      this.transition({ kind: "loading" });
    }
    // Drop the auto-greet one-shot too — otherwise a stale `true` set
    // by the outgoing user's hatch path (but never consumed by
    // ChatPage before logout) would seed the incoming user's first
    // mount with a spurious "Connecting..." gate.
    this.clearExpectingFirstMessage();
  }

  /**
   * Reconcile against the current inputs — drives initial bootstrap
   * (post-login `checkAssistant`), logout reset, and the local-mode
   * branches. Safe to call on every input change.
   */
  async respondToInputs(): Promise<void> {
    if (!this.ready) return;
    if (!isAuthenticated(this.inputs.sessionStatus)) {
      // Logout / pre-auth boot — same reset as `resetForLogout` but
      // reachable from the input-driven path for token-expiry style
      // flips that don't call `logout()` explicitly.
      this.resetForLogout();
      return;
    }

    if (isGatewayAuthMode()) {
      this.applyGatewayAuthShortCircuit();
      return;
    }
    if (
      isLocalMode() &&
      !isGatewayAuthMode() &&
      !this.inputs.hasPlatformSession
    ) {
      const redirect = this.inputs.resolveOnboardingRedirect({
        intendedDestination: window.location.pathname,
      });
      if (redirect) this.inputs.onRedirect(redirect);
      return;
    }
    if (this.inputs.hasPlatformSession) {
      setSelfHostedConnection(null);
    }
    if (!this.inputs.isOrgReady) return;
    await this.checkAssistant();
  }

  /**
   * Project a fresh `/assistant/` poll result into local state.
   * Called by the React wiring on every `useAssistantQuery` data
   * change — the service decides whether to act on it (only while
   * the lifecycle is transient).
   */
  async applyServerResult(result: GetAssistantResult): Promise<void> {
    if (!this.ready) return;
    if (this.state.kind !== "initializing" && this.state.kind !== "cleaning_up") {
      return;
    }
    await this.applyServerStateUpdate(result);
  }

  // ---------------------------------------------------------------------------
  // Imperative actions — called from event handlers / consumers
  // ---------------------------------------------------------------------------

  async checkAssistant(): Promise<void> {
    if (!this.ready) return;
    if (isGatewayAuthMode()) {
      this.applyGatewayAuthShortCircuit();
      return;
    }
    const generation = this.generation;
    try {
      // Force a fresh fetch through the query cache. `fetchQuery`
      // updates the cache atomically so any other subscriber
      // (sidebar header, identity panel, etc.) sees the same answer
      // this code path acts on. `staleTime: 0` is required: the
      // app's QueryClient sets a 10s default staleTime, and
      // imperative re-checks (visibility-change return, retry
      // button, onboarding pre-chat verification) must hit the
      // network so a 10s-old cached 404 or initializing result
      // doesn't silently replay. Poll-driven projections go through
      // `applyServerResult` to avoid the read-back loop.
      const selectedId = this.inputs.selectedPlatformAssistantId ?? null;
      const result = await this.inputs.queryClient.fetchQuery({
        queryKey: assistantQueryKey(selectedId),
        queryFn: () => getAssistant(selectedId ?? undefined),
        staleTime: 0,
      });
      if (generation !== this.generation) return;
      await this.applyServerStateUpdate(result);
    } catch (err) {
      console.error("Error checking assistant status:", err);
      captureError(err, { context: "check_assistant" });
      if (generation !== this.generation) return;
      this.transition({
        kind: "error",
        message: "Network error. Please check your connection and try again.",
      });
    }
  }

  retryAssistant(): void {
    if (!this.ready) return;
    this.hatchRetryCount = 0;
    this.initializingRecoveryCount = 0;
    void this.checkAssistant();
  }

  /**
   * Mark the chat surface as expecting an auto-greet. Called from
   * the vanilla auto-hatch inside this service, the onboarding
   * hatching screen, pre-chat-flow, and the chat-page mount-time
   * pre-chat sessionStorage detector externally.
   */
  markExpectingFirstMessage(): void {
    if (useAssistantLifecycleStore.getState().expectingFirstMessage) return;
    useAssistantLifecycleStore.setState({ expectingFirstMessage: true });
  }

  clearExpectingFirstMessage(): void {
    if (!useAssistantLifecycleStore.getState().expectingFirstMessage) return;
    useAssistantLifecycleStore.setState({ expectingFirstMessage: false });
  }

  // ---------------------------------------------------------------------------
  // Private state machine
  // ---------------------------------------------------------------------------

  private transition(next: AssistantState): void {
    const prevKind = this.state.kind;
    this.state = next;
    useAssistantLifecycleStore.setState({ assistantState: next });
    // Watchdog edge-trigger: entering `initializing` arms it,
    // leaving clears it. A repeat `initializing → initializing`
    // is a no-op so back-to-back poll results that re-confirm
    // the same phase don't reset the 5-minute clock — only a
    // fresh hatch attempt should, and `hatchAndCheck` calls
    // `armInitializingWatchdog()` explicitly for that.
    if (next.kind !== "initializing") {
      if (this.initializingTimeout) {
        clearTimeout(this.initializingTimeout);
        this.initializingTimeout = null;
      }
    } else if (prevKind !== "initializing") {
      this.armInitializingWatchdog();
    }
    // Drop the auto-greet one-shot on any transition to a state
    // where a greeting is no longer forthcoming. The only two
    // states where the expectation still holds are `initializing`
    // (hatch in progress) and `active` (greeting may have just
    // arrived or be arriving via SSE).
    if (next.kind !== "initializing" && next.kind !== "active") {
      this.clearExpectingFirstMessage();
    }
  }

  private armInitializingWatchdog(): void {
    if (this.initializingTimeout) clearTimeout(this.initializingTimeout);
    this.initializingTimeout = setTimeout(() => {
      Sentry.captureMessage("Assistant hatch stuck in initializing state", {
        level: "warning",
        extra: { timeoutMs: INITIALIZING_TIMEOUT_MS },
      });
      void this.recoverStuckInitializingAssistant();
    }, INITIALIZING_TIMEOUT_MS);
  }

  /**
   * Gateway-auth resolves the assistant locally — bypasses
   * `/assistant/` entirely because the gateway issues the session
   * token directly. Mount-time init and imperative `checkAssistant`
   * both short-circuit through this; keep them in lockstep.
   */
  /**
   * Project a managed-active server result. Drops any stale
   * self-hosted connection (runtime calls belong on the platform
   * now, and we don't want a leftover token attached), sets the
   * id BEFORE the kind flips so the conversation list query and
   * the unreachable-bus interceptor have a target on first
   * `kind === "active"` render, then transitions.
   */
  private projectActive(
    result: GetAssistantResult & { ok: true },
  ): void {
    const mm = result.data.maintenance_mode;
    setSelfHostedConnection(null);
    const store = useResolvedAssistantsStore.getState();
    store.upsertFromApi(result.data);
    store.setActiveAssistantId(result.data.id);
    this.transition({
      kind: "active",
      isLocal: result.data.is_local ?? false,
      maintenanceMode: { enabled: mm?.enabled },
    });
  }

  /**
   * Project a self-hosted server result. Records the user's
   * gateway + actor token so the request interceptor can rewrite
   * runtime-proxied calls to the gateway and attach
   * `Authorization: Bearer`. The slots have to be primed before
   * `assistantId` flips, otherwise the first conversation list
   * fetch races us and hits the platform.
   *
   * Both `ingress_url` and `platform_actor_token` are nullable
   * in the serializer:
   *   - `ingress_url`: an assistant can be `is_local=true` before
   *     its gateway hostname is known. In that case the URL slot
   *     stays null and the platform's proxy view 404s cleanly.
   *   - `platform_actor_token`: brief window after hatch where
   *     `bootstrap_platform_actor_token` is still in-flight. The
   *     request fires unauthenticated, the gateway responds 401,
   *     and the chat surface lands on its error state.
   */
  private projectSelfHosted(
    result: GetAssistantResult & { ok: true },
  ): void {
    setSelfHostedConnection({
      url: result.data.ingress_url,
      token: result.data.platform_actor_token,
    });
    const store = useResolvedAssistantsStore.getState();
    store.upsertFromApi(result.data);
    store.setActiveAssistantId(result.data.id);
    this.transition({ kind: "self_hosted" });
  }

  private applyGatewayAuthShortCircuit(): void {
    let ingressUrl = window.location.origin;
    let resolvedAssistantId = "self";
    const localGateway = getLocalGatewayUrl();
    if (localGateway) {
      const assistant = getSelectedAssistant();
      ingressUrl = `${window.location.origin}${localGateway}`;
      resolvedAssistantId = assistant?.assistantId ?? resolvedAssistantId;
    }
    setSelfHostedConnection({ url: ingressUrl, token: getGatewayToken() });
    useResolvedAssistantsStore
      .getState()
      .setActiveAssistantId(resolvedAssistantId);
    this.transition({ kind: "active", isLocal: true });
  }

  private async applyServerStateUpdate(
    result: GetAssistantResult,
  ): Promise<void> {
    const generation = this.generation;
    const nextState = resolveAssistantLifecycleState(result);
    if (result.ok && nextState.kind === "initializing") {
      this.initializingAssistantId = result.data.id;
    } else if (nextState.kind !== "initializing") {
      this.initializingAssistantId = null;
    }

    if (nextState.kind === "auto_hatch") {
      // If we just retired, show the retired screen instead of auto-hatching.
      if (this.inputs.isRetired) {
        this.transition({ kind: "retired" });
        return;
      }
      // New signups without completed onboarding land on
      // `/onboarding/privacy` before we hatch an assistant for them.
      const onboardingRedirect = this.inputs.resolveOnboardingRedirect({
        intendedDestination: window.location.pathname,
      });
      if (onboardingRedirect) {
        this.inputs.onRedirect(onboardingRedirect);
        return;
      }
      // Auto-hatch: a new signup with no assistant lands here.
      // Mark the auto-greet one-shot so the next `ChatPage` mount
      // shows the loading gate until the server's greeting SSE
      // arrives.
      this.markExpectingFirstMessage();
      await this.hatchAndCheck();
      return;
    }

    if (nextState.kind === "active" && result.ok) {
      this.initializingRecoveryCount = 0;
      this.hatchingVersion = undefined;
      this.projectActive(result);
      return;
    }

    if (nextState.kind === "self_hosted" && result.ok) {
      this.initializingRecoveryCount = 0;
      this.hatchingVersion = undefined;
      this.projectSelfHosted(result);
      return;
    }

    if (generation !== this.generation) return;
    if (nextState.kind !== "active") {
      this.transition(nextState);
    }
  }

  private async hatchAndCheck(version?: string): Promise<void> {
    if (this.hatching) return;

    if (this.hatchRetryCount >= MAX_HATCH_RETRIES) {
      this.transition({
        kind: "error",
        message:
          "Failed to start your assistant after multiple attempts. Please refresh the page to try again.",
      });
      return;
    }

    this.hatching = true;
    this.hatchingVersion = version;
    const generation = this.generation;
    this.transition({ kind: "initializing" });
    // Restart the 5-minute watchdog for every fresh hatch attempt
    // (transition is a no-op kind-wise when we were already
    // initializing, but a new attempt deserves a new clock).
    this.armInitializingWatchdog();
    try {
      const result = await hatchAssistant(version ? { version } : undefined);
      if (generation !== this.generation) return;
      if (result.ok) {
        this.initializingAssistantId = result.data.id;
        // Seed the assistant-query cache with the hatch response so
        // post-hatch polling actually begins. The initial
        // `/assistant/` read for a fresh user caches a 404; without
        // this seed, `pollIntervalFor(404)` keeps the query idle
        // and newly-hatched users sit on the initializing screen
        // until the 5-minute stuck-assistant recovery timer fires.
        // The hatch response is shape-compatible with
        // `GetAssistantResult`, so projecting it directly avoids an
        // extra round-trip.
        this.inputs.queryClient.setQueryData<GetAssistantResult>(
          ASSISTANT_QUERY_KEY,
          { ok: true, status: result.status, data: result.data },
        );
      }
      if (!result.ok) {
        this.hatchRetryCount += 1;
        Sentry.captureMessage("Hatch request failed", {
          level: "warning",
          extra: {
            status: result.status,
            error: result.error,
            attempt: this.hatchRetryCount,
          },
        });
        // Capacity kill-switch: when platform hosting is unavailable
        // the backend returns 503. Surface the tailored message
        // instead of treating this as a recoverable 5xx — retrying
        // just burns the MAX_HATCH_RETRIES budget and ends in a
        // generic error.
        if (isPlatformHostedDisabled(result.status, result.error)) {
          this.transition({
            kind: "error",
            message: PLATFORM_HOSTED_DISABLED_MESSAGE,
          });
          return;
        }
        if (shouldRecoverFromHatchFailure(result.status)) {
          this.transition({ kind: "initializing" });
          // Cache is still 404 → `pollIntervalFor` keeps the query
          // idle → no automatic retry. Space the next attempt by
          // `POLL_INTERVAL_MS` to preserve the 3-second backoff
          // between hatch retries: rapid back-to-back invalidations
          // burn the `MAX_HATCH_RETRIES` budget in milliseconds and
          // hammer the server.
          setTimeout(() => {
            void this.inputs.queryClient.invalidateQueries({
              queryKey: ASSISTANT_QUERY_KEY,
            });
          }, POLL_INTERVAL_MS);
          return;
        }

        this.transition({
          kind: "error",
          message: extractErrorMessage(
            result.error,
            undefined,
            "Failed to start your assistant. Please refresh the page to try again.",
          ),
        });
        return;
      }
      this.hatchRetryCount = 0;
    } catch (err) {
      this.hatchRetryCount += 1;
      captureError(err, { context: "hatch_assistant" });
      if (generation !== this.generation) return;
      this.transition({ kind: "initializing" });
      // Network error during hatch behaves like a recoverable
      // failure (cache still 404, no automatic poll). Apply the
      // same 3-second backoff before driving the next attempt.
      setTimeout(() => {
        void this.inputs.queryClient.invalidateQueries({
          queryKey: ASSISTANT_QUERY_KEY,
        });
      }, POLL_INTERVAL_MS);
      return;
    } finally {
      this.hatching = false;
    }
    if (generation !== this.generation) return;
    // Re-assert `initializing` so the poll loop restarts in case an
    // early poll returned 404 and switched state to `initializing`
    // while the hatch request was still in-flight.
    this.transition({ kind: "initializing" });
  }

  private async recoverStuckInitializingAssistant(): Promise<void> {
    if (this.initializingRecoveryCount >= MAX_INITIALIZING_RECOVERIES) {
      this.generation++;
      this.transition(buildInitializingTimeoutError());
      return;
    }

    this.initializingRecoveryCount++;
    this.generation++;
    const generation = this.generation;

    try {
      let assistantIdToRetire = this.initializingAssistantId;
      if (!assistantIdToRetire) {
        // Force-refresh the cached status. We need to know whether
        // the assistant moved off `initializing` before deciding
        // whether to retire-and-rehatch — a cached 10s-old
        // `initializing` result would mislead the decision into an
        // unnecessary retire.
        const result = await this.inputs.queryClient.fetchQuery({
          queryKey: ASSISTANT_QUERY_KEY,
          queryFn: () => getAssistant(),
          staleTime: 0,
        });
        if (generation !== this.generation) return;
        if (result.ok && result.data.status === "initializing") {
          assistantIdToRetire = result.data.id;
        } else {
          const nextState = resolveAssistantLifecycleState(result);
          this.initializingAssistantId = null;
          if (nextState.kind === "auto_hatch") {
            await this.hatchAndCheck(this.hatchingVersion);
          } else if (nextState.kind === "active" && result.ok) {
            this.initializingRecoveryCount = 0;
            this.projectActive(result);
            // Note: `hatchingVersion` is intentionally not cleared
            // on the recovery path's active landing — matches the
            // shape this code carried before being extracted. Not
            // observable to consumers either way (only `hatchAndCheck`
            // reads it, and we won't re-enter that until the next
            // user-driven retry).
          } else if (nextState.kind === "self_hosted" && result.ok) {
            // An assistant can graduate from `initializing` straight
            // into `is_local: true` once it registers its gateway.
            // Without this branch the recovery path leaves
            // `assistantId` null and the chat surface keeps showing
            // the initializing-timeout error after the assistant
            // has come up.
            this.initializingRecoveryCount = 0;
            this.projectSelfHosted(result);
          } else if (nextState.kind !== "active") {
            this.transition(nextState);
          }
          return;
        }
      }

      // Prevent the poll loop from calling `hatchAndCheck()` while
      // we retire the stuck assistant. Without this, a poll that
      // observes the 404 (after the retire takes effect on the
      // backend but before our own `hatchAndCheck` creates the
      // replacement) races to create a duplicate.
      this.hatching = true;

      const retireResult = await retireAssistantById(assistantIdToRetire);
      if (generation !== this.generation) {
        this.hatching = false;
        return;
      }
      if (!retireResult.ok && retireResult.status !== 404) {
        this.hatching = false;
        Sentry.captureMessage(
          "Failed to retire stuck initializing assistant",
          {
            level: "warning",
            extra: { status: retireResult.status, error: retireResult.error },
          },
        );
        this.transition(buildInitializingTimeoutError());
        return;
      }

      this.initializingAssistantId = null;
      useResolvedAssistantsStore.getState().setActiveAssistantId(null);
      this.hatching = false;
      await this.hatchAndCheck(this.hatchingVersion);
    } catch (err) {
      this.hatching = false;
      captureError(err, { context: "recover_stuck_initializing_assistant" });
      if (generation !== this.generation) return;
      this.transition(buildInitializingTimeoutError());
    }
  }

  /**
   * Reset all state to the post-import default. For tests only —
   * production code should never call this. (Use `respondToInputs`
   * with a non-authenticated `sessionStatus` for logout reset.)
   */
  __resetForTesting(): void {
    if (this.initializingTimeout) {
      clearTimeout(this.initializingTimeout);
      this.initializingTimeout = null;
    }
    this.state = { kind: "loading" };
    this.hatching = false;
    this.hatchRetryCount = 0;
    this.initializingAssistantId = null;
    this.initializingRecoveryCount = 0;
    this.hatchingVersion = undefined;
    this.generation = 0;
    this.ready = false;
    useAssistantLifecycleStore.setState({ expectingFirstMessage: false });
    this.inputs = {
      sessionStatus: "initializing",
      isRetired: false,
      hasPlatformSession: false,
      onRedirect: NOOP_REDIRECT,
      resolveOnboardingRedirect: NOOP_RESOLVE,
      queryClient: null as unknown as QueryClient,
    };
    useAssistantLifecycleStore.setState({ assistantState: this.state });
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
  }
}

export const lifecycleService = new AssistantLifecycleService();
