/**
 * Assistant lifecycle state machine — the non-React core.
 *
 * State projector that polls the `/assistant/` endpoint and
 * publishes its observable state — `assistantState` and
 * `activeAssistantId` — into the two Zustand stores
 * (`useAssistantLifecycleStore`, `useResolvedAssistantsStore`),
 * which is how the React tree reads it. Also owns the generation
 * counter that drops stale async responses on timeout escalations,
 * the 5-minute stuck-initializing watchdog, and the gateway-auth
 * short-circuit.
 *
 * Inputs from React (auth, env, the TanStack Query client) flow
 * in through `setInputs()`;
 * `useAssistantLifecycle` is the thin wiring layer that pushes
 * them.
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
  getAssistantHealthz,
  type GetAssistantResult,
} from "@/assistant/api";
import { subscribeAssistantUnreachable } from "@/assistant/unreachable-bus";
import {
  buildInitializingTimeoutError,
  errorRetryDelayMs,
  INITIALIZING_TIMEOUT_MS,
  resolveAssistantLifecycleState,
  TRANSPORT_ERROR_MESSAGE,
} from "@/assistant/lifecycle";
import { subscribe } from "@/lib/event-bus";
import { ASSISTANT_QUERY_KEY, assistantQueryKey } from "@/assistant/queries";
import { deriveLocalAssistantHealth } from "@/assistant/local-health";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { AssistantState, LocalAssistantHealth } from "@/assistant/types";
import { isGatewayAuthMode, getGatewayToken } from "@/lib/auth/gateway-session";
import {
  getSelectedAssistant,
  getLocalGatewayUrl,
  isRemoteGatewayMode,
} from "@/lib/local-mode";
import { getLocalAssistantStatusHost } from "@/runtime/local-mode-host";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { isAuthenticated, type SessionStatus } from "@/stores/session-status";

const PROBE_RETRY_DELAY_MS = 4_000;
const PROBE_RETRY_LIMIT_MS = 60_000;
const LOCAL_HEALTH_POLL_MS = 5_000;

function getRemoteGatewayIngressUrl(): string {
  const match = /\/assistant(?:\/|$)/.exec(window.location.pathname);
  const prefix =
    match && match.index > 0
      ? window.location.pathname.slice(0, match.index).replace(/\/+$/, "")
      : "";
  return `${window.location.origin}${prefix}`;
}

export interface LifecycleServiceInputs {
  sessionStatus: SessionStatus;
  hasPlatformSession: boolean;
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

class AssistantLifecycleService {
  private state: AssistantState = { kind: "loading" };
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
    hasPlatformSession: false,
    queryClient: null as unknown as QueryClient,
    selectedPlatformAssistantId: null,
  };
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private healthHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** Assistant the heartbeat is running for; null when no heartbeat. */
  private healthHeartbeatId: string | null = null;
  /**
   * Invalidates in-flight heartbeat ticks on cancel/restart. A tick
   * holds an await across `getAssistantHealthz`; without the token, a
   * stale tick resolving after a restart would re-arm its own timer
   * alongside the new heartbeat's and leave two loops running.
   */
  private healthHeartbeatToken = 0;
  /**
   * Health probes can synchronously emit `assistant_unreachable` through
   * the API interceptor before their own await path finishes. Track the
   * assistant ids already being probed so that event can mark the state
   * degraded without recursively starting another `/healthz` request.
   */
  private reachabilityProbeInFlightIds = new Set<string>();
  /**
   * Tracks the assistant being actively probed. Non-null when a probe
   * loop is running (timer pending OR tick in-flight). Prevents
   * re-entry: the probe's own 502 response fires the unreachable-bus
   * which calls `triggerReachabilityProbe` again — without this guard
   * each re-entry creates an orphaned timer that can never be
   * cancelled, doubling probe traffic on every cycle and consuming CPU.
   *
   * Storing the assistantId (rather than a bare boolean) allows a
   * switch to a different assistant to cancel the stale loop and start
   * a fresh one.
   */
  private probeLoopAssistantId: string | null = null;
  /**
   * Auto-retry for transient (transport-shaped) error states —
   * armed by `transition` on entering such a state, cleared on
   * leaving it. The attempt counter drives the backoff schedule and
   * resets once the lifecycle leaves `error` entirely.
   */
  private errorRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRetryAttempt = 0;

  constructor() {
    subscribeAssistantUnreachable(() => this.onUnreachable());
    // Network-back signal: retry a transient error immediately (no
    // point waiting out the backoff once the browser says we're
    // online) and re-check a degraded-active session so the
    // "Reconnecting…" banner clears as soon as possible.
    subscribe("app.online", () => this.onNetworkOnline());
    // Republish `activeAssistantId` whenever the selection changes, at the
    // store funnel so every writer (and future ones) is covered — gateway-auth
    // mode has no other republish path while connected (the React effect's
    // deps pin the resolved selection to null there). The `loading` guard
    // keeps the initial publish owned by `respondToInputs` and prevents a
    // mid-logout clear from resurrecting an active state (`resetForLogout`
    // runs before the clear). Fires synchronously inside the write, bypassing
    // the `ready` guard — must not read `this.inputs`. Platform mode is
    // deliberately not handled here: its resolver-fed effect path already
    // re-checks, and acting on it would double-fetch with stale inputs.
    useResolvedAssistantsStore.subscribe((state, prevState) => {
      if (state.selectedAssistantId === prevState.selectedAssistantId) return;
      if (!isGatewayAuthMode() || this.state.kind === "loading") return;
      this.applyGatewayAuthShortCircuit();
    });
  }

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
    this.setOperationalStatusAssistantId(null);
    this.cancelProbeTimer();
    this.probeLoopAssistantId = null;
    this.reachabilityProbeInFlightIds.clear();
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
    // Check gateway auth before the unauthenticated-reset below: local (gateway)
    // and platform are independent authorities, so a platform-session loss that
    // flips `sessionStatus` must not tear down a gateway-driven local lifecycle.
    if (isGatewayAuthMode()) {
      this.applyGatewayAuthShortCircuit();
      return;
    }
    if (!isAuthenticated(this.inputs.sessionStatus)) {
      // Logout / pre-auth boot — same reset as `resetForLogout` but
      // reachable from the input-driven path for token-expiry style
      // flips that don't call `logout()` explicitly.
      this.resetForLogout();
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
    if (
      this.state.kind !== "initializing" &&
      this.state.kind !== "cleaning_up"
    ) {
      return;
    }
    await this.applyServerStateUpdate(result);
  }

  // ---------------------------------------------------------------------------
  // Imperative actions — called from event handlers / consumers
  // ---------------------------------------------------------------------------

  /**
   * Force a fresh assistant-status fetch and project it.
   *
   * `assistantIdOverride` pins this one refresh to a specific assistant
   * instead of the multi-assistant selection carried in
   * `inputs.selectedPlatformAssistantId`. The onboarding handoff uses it so a
   * just-hatched assistant is the one fetched and projected — otherwise, in a
   * multi-assistant session where a *different* assistant is already selected,
   * the refresh would re-fetch that selection and `projectActive` would
   * overwrite the active id back to it, sending the onboarding payload to the
   * wrong assistant.
   */
  async checkAssistant(assistantIdOverride?: string): Promise<void> {
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
      const selectedId =
        assistantIdOverride ?? this.inputs.selectedPlatformAssistantId ?? null;
      let result = await this.inputs.queryClient.fetchQuery({
        queryKey: assistantQueryKey(selectedId),
        queryFn: () => getAssistant(selectedId ?? undefined),
        staleTime: 0,
      });
      if (generation !== this.generation) return;
      // If the selected assistant 404s (retired/deleted), clear the
      // stale selection and retry without an ID so the lifecycle
      // falls back to the default first-listed assistant.
      if (selectedId && !result.ok && result.status === 404) {
        useResolvedAssistantsStore.getState().setSelectedAssistant(null);
        result = await this.inputs.queryClient.fetchQuery({
          queryKey: ASSISTANT_QUERY_KEY,
          queryFn: () => getAssistant(),
          staleTime: 0,
        });
        if (generation !== this.generation) return;
      }
      await this.applyServerStateUpdate(result);
    } catch (err) {
      console.error("Error checking assistant status:", err);
      captureError(err, { context: "check_assistant" });
      if (generation !== this.generation) return;
      // A thrown fetch is a transport failure (the request never got
      // an HTTP answer) — same degrade/auto-retry semantics as a
      // proxy-synthesized network error result.
      if (this.degradeOnTransportFailure()) return;
      this.transition({
        kind: "error",
        transient: true,
        message: TRANSPORT_ERROR_MESSAGE,
      });
    }
  }

  /**
   * Shared handling for transport-shaped failures (wake-time network
   * flap, device offline): a live or in-progress surface must not be
   * torn down for a connectivity blip (LUM-2402, the post-sleep
   * `net::ERR_NETWORK_CHANGED` full-screen error).
   *
   * Returns true when the failure was absorbed:
   *   - `active` → degrade to `reachable: false` (existing probe loop
   *     + "Reconnecting…" banner) and self-heal when the probe lands.
   *   - `initializing` / `cleaning_up` → stay put; the background
   *     poll keeps reporting and the stuck-initializing watchdog is
   *     the backstop for a real outage.
   * Returns false for `loading`/`error`, where there is no surface to
   * preserve — the caller transitions to a transient error state,
   * whose auto-retry takes over.
   */
  private degradeOnTransportFailure(): boolean {
    if (this.state.kind === "active") {
      this.triggerReachabilityProbe();
      return true;
    }
    return (
      this.state.kind === "initializing" || this.state.kind === "cleaning_up"
    );
  }

  retryAssistant(): void {
    if (!this.ready) return;
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
    // the same phase don't reset the 5-minute clock.
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
    // Heartbeat edge-trigger: the health heartbeat only lives while
    // the state is a local assistant. The projectors start it;
    // leaving for any non-local state stops it.
    const nextIsLocalAssistant =
      next.kind === "self_hosted" || (next.kind === "active" && next.isLocal);
    if (!nextIsLocalAssistant && this.healthHeartbeatId !== null) {
      this.cancelHealthHeartbeat();
    }
    // Auto-retry edge-trigger: entering a transient (transport-shaped)
    // error arms the next backoff step — including error → error
    // re-entries, which are how a failed retry schedules the following
    // one. Leaving `error` entirely resets the backoff schedule; a
    // non-transient error stops auto-retrying but keeps the attempt
    // count (it's terminal until the user or a network signal acts).
    if (next.kind === "error" && next.transient) {
      this.armErrorRetry();
    } else {
      this.clearErrorRetry(next.kind !== "error");
    }
  }

  private clearErrorRetry(resetAttempts: boolean): void {
    if (this.errorRetryTimer) {
      clearTimeout(this.errorRetryTimer);
      this.errorRetryTimer = null;
    }
    if (resetAttempts) this.errorRetryAttempt = 0;
  }

  private armErrorRetry(): void {
    if (this.errorRetryTimer) clearTimeout(this.errorRetryTimer);
    const delay = errorRetryDelayMs(this.errorRetryAttempt);
    this.errorRetryAttempt += 1;
    this.errorRetryTimer = setTimeout(() => {
      this.errorRetryTimer = null;
      void this.checkAssistant();
    }, delay);
  }

  /**
   * `app.online` — the browser observed the network coming back.
   * Skip the remaining backoff and retry now: a transient error
   * re-checks the assistant from scratch (backoff reset so a
   * follow-up flap starts the schedule over), and a degraded-active
   * session re-checks so its banner clears without waiting for the
   * probe loop's next tick.
   */
  private onNetworkOnline(): void {
    if (!this.ready) return;
    if (this.state.kind === "error" && this.state.transient) {
      this.clearErrorRetry(true);
      void this.checkAssistant();
      return;
    }
    if (this.state.kind === "active" && this.state.reachable === false) {
      void this.checkAssistant();
    }
  }

  private armInitializingWatchdog(): void {
    if (this.initializingTimeout) clearTimeout(this.initializingTimeout);
    this.initializingTimeout = setTimeout(() => {
      this.generation++;
      Sentry.captureMessage("Assistant stuck in initializing state", {
        level: "warning",
        extra: { timeoutMs: INITIALIZING_TIMEOUT_MS },
      });
      this.transition(buildInitializingTimeoutError());
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
  private projectActive(result: GetAssistantResult & { ok: true }): void {
    const mm = result.data.maintenance_mode;
    const isLocal = result.data.is_local ?? false;
    setSelfHostedConnection(null);
    this.setOperationalStatusAssistantId(result.data.id);
    const store = useResolvedAssistantsStore.getState();
    store.upsertFromApi(result.data);
    store.setActiveAssistantId(result.data.id);
    this.transition({
      kind: "active",
      isLocal,
      maintenanceMode: { enabled: mm?.enabled },
    });
    if (isLocal) {
      this.startHealthHeartbeat(result.data.id);
    } else {
      void this.probeReachability(result.data.id);
    }
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
  private projectSelfHosted(result: GetAssistantResult & { ok: true }): void {
    this.setOperationalStatusAssistantId(null);
    setSelfHostedConnection({
      url: result.data.ingress_url,
      token: result.data.platform_actor_token,
    });
    const store = useResolvedAssistantsStore.getState();
    store.upsertFromApi(result.data);
    store.setActiveAssistantId(result.data.id);
    this.transition({ kind: "self_hosted" });
    this.startHealthHeartbeat(result.data.id);
  }

  private applyGatewayAuthShortCircuit(): void {
    let ingressUrl = window.location.origin;
    let resolvedAssistantId = "self";
    const localGateway = getLocalGatewayUrl();
    if (isRemoteGatewayMode()) {
      ingressUrl = getRemoteGatewayIngressUrl();
    } else if (localGateway) {
      const assistant = getSelectedAssistant();
      ingressUrl = `${window.location.origin}${localGateway}`;
      resolvedAssistantId = assistant?.assistantId ?? resolvedAssistantId;
    }
    setSelfHostedConnection({ url: ingressUrl, token: getGatewayToken() });
    this.setOperationalStatusAssistantId(null);
    useResolvedAssistantsStore
      .getState()
      .setActiveAssistantId(resolvedAssistantId);
    this.transition({ kind: "active", isLocal: true });
    this.startHealthHeartbeat(resolvedAssistantId);
  }

  private async applyServerStateUpdate(
    result: GetAssistantResult,
  ): Promise<void> {
    const generation = this.generation;
    const nextState = resolveAssistantLifecycleState(result);

    // Transport-shaped failure: absorb it before any store writes so
    // a degraded-active session keeps its operational-status id (the
    // status banner's polling target) along with its surface.
    if (
      nextState.kind === "error" &&
      nextState.transient &&
      this.degradeOnTransportFailure()
    ) {
      return;
    }

    if (result.ok) {
      this.setOperationalStatusAssistantId(result.data.id);
    } else {
      this.setOperationalStatusAssistantId(null);
    }

    if (nextState.kind === "auto_hatch") {
      // No assistant found. Don't hatch or redirect — the navigation
      // resolver's requireAssistant step handles routing to the
      // correct onboarding screen. Just leave the current state as-is.
      return;
    }

    if (nextState.kind === "active" && result.ok) {
      this.projectActive(result);
      return;
    }

    if (nextState.kind === "self_hosted" && result.ok) {
      this.projectSelfHosted(result);
      return;
    }

    if (generation !== this.generation) return;
    if (nextState.kind !== "active") {
      this.transition(nextState);
    }
  }

  // ---------------------------------------------------------------------------
  // Reachability probe
  // ---------------------------------------------------------------------------

  private async probeReachability(assistantId: string): Promise<void> {
    if (this.reachabilityProbeInFlightIds.has(assistantId)) return;
    this.reachabilityProbeInFlightIds.add(assistantId);
    try {
      const generation = this.generation;
      const isLocalLifecycleState =
        this.state.kind === "self_hosted" ||
        (this.state.kind === "active" && this.state.isLocal);
      const localStatusAssistantId = isLocalLifecycleState
        ? (getSelectedAssistant()?.assistantId ?? assistantId)
        : assistantId;
      let localStatus =
        !isRemoteGatewayMode() && isLocalLifecycleState
          ? await getLocalAssistantStatusHost(localStatusAssistantId).catch(
              () => null,
            )
          : null;
      let health: LocalAssistantHealth =
        localStatus?.ok && localStatus.state === "upgrading"
          ? "upgrading"
          : "unreachable";

      if (health !== "upgrading") {
        try {
          health = deriveLocalAssistantHealth(
            await getAssistantHealthz(assistantId),
          );
        } catch {
          health = "unreachable";
        }
      }
      if (health === "unreachable" && !localStatus && !isRemoteGatewayMode()) {
        localStatus = await getLocalAssistantStatusHost(
          localStatusAssistantId,
        ).catch(() => null);
      }
      if (health === "unreachable" && localStatus?.ok) {
        switch (localStatus.state) {
          case "healthy":
            health = "healthy";
            break;
          case "sleeping":
          case "starting":
          case "upgrading":
          case "unhealthy":
          case "crashed":
            health = localStatus.state;
            break;
          case "unknown":
            break;
        }
      }
      if (generation !== this.generation) return;
      if (
        useResolvedAssistantsStore.getState().activeAssistantId !== assistantId
      ) {
        return;
      }
      if (this.state.kind === "self_hosted") {
        if (this.state.health !== health) {
          this.transition({ ...this.state, health });
        }
        return;
      }
      if (this.state.kind !== "active") return;
      // A migrating daemon is reachable — its HTTP server answers health
      // checks; only DB-backed routes are gated until migrations settle.
      const reachable =
        health === "healthy" ||
        health === "unhealthy" ||
        health === "migrating";
      // Heartbeat ticks re-confirm the same answer most of the time —
      // don't wake every store subscriber for a no-op.
      if (this.state.reachable === reachable && this.state.health === health) {
        return;
      }
      this.transition({ ...this.state, reachable, health });
    } finally {
      this.reachabilityProbeInFlightIds.delete(assistantId);
    }
  }

  private cancelProbeTimer(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private startProbeLoop(assistantId: string): void {
    if (this.probeLoopAssistantId === assistantId) return;
    this.cancelProbeTimer();
    this.probeLoopAssistantId = assistantId;
    const startedAt = Date.now();
    const exit = () => {
      this.probeLoopAssistantId = null;
    };
    const tick = async () => {
      if (this.state.kind !== "active" || this.state.reachable === true) {
        exit();
        return;
      }
      if (Date.now() - startedAt > PROBE_RETRY_LIMIT_MS) {
        exit();
        return;
      }
      await this.probeReachability(assistantId);
      const s = this.state;
      if (s.kind !== "active" || s.reachable === true) {
        exit();
        return;
      }
      if (Date.now() - startedAt > PROBE_RETRY_LIMIT_MS) {
        exit();
        return;
      }
      this.probeTimer = setTimeout(() => void tick(), PROBE_RETRY_DELAY_MS);
    };
    this.probeTimer = setTimeout(() => void tick(), PROBE_RETRY_DELAY_MS);
  }

  /**
   * Continuous daemon-health heartbeat for local / self-hosted
   * assistants. Platform-hosted assistants surface health through the
   * centralized operational-status API and keep the event-driven
   * probe; local assistants have no platform-side signal, so the
   * service polls the daemon's own healthz and projects the result
   * into `assistantState.health` for the status banner. Stopped by
   * `transition()`'s edge-trigger when the state leaves local.
   */
  private startHealthHeartbeat(assistantId: string): void {
    if (this.healthHeartbeatId === assistantId) return;
    this.cancelHealthHeartbeat();
    this.healthHeartbeatId = assistantId;
    const token = this.healthHeartbeatToken;
    const tick = async () => {
      if (token !== this.healthHeartbeatToken) return;
      await this.probeReachability(assistantId);
      if (token !== this.healthHeartbeatToken) return;
      this.healthHeartbeatTimer = setTimeout(
        () => void tick(),
        LOCAL_HEALTH_POLL_MS,
      );
    };
    void tick();
  }

  private cancelHealthHeartbeat(): void {
    this.healthHeartbeatToken++;
    this.healthHeartbeatId = null;
    if (this.healthHeartbeatTimer) {
      clearTimeout(this.healthHeartbeatTimer);
      this.healthHeartbeatTimer = null;
    }
  }

  private onUnreachable(): void {
    this.triggerReachabilityProbe();
  }

  /**
   * Kick off a reachability probe. Marks `reachable: false` and
   * starts the background probe loop so the lifecycle store's
   * `reachable` field updates when the daemon responds. Called
   * internally by the unreachable-bus subscriber and externally
   * by the reachability hook on SSE drops / user retry.
   *
   * `health` is deliberately NOT flipped here — it only ever reflects
   * a completed probe, so the status banner doesn't flash
   * "unreachable" on every transient SSE bounce while the chat
   * overlay (driven by `reachable`) handles the acute state.
   */
  triggerReachabilityProbe(): void {
    if (this.state.kind !== "active") return;
    const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
    if (!assistantId) return;
    this.transition({ ...this.state, reachable: false });
    if (this.healthHeartbeatId === assistantId) {
      // The heartbeat owns the cadence — just pull the next probe
      // forward instead of racing a second retry loop against it.
      void this.probeReachability(assistantId);
      return;
    }
    this.startProbeLoop(assistantId);
  }

  setLocalAssistantUpgradeInProgress(
    assistantId: string,
    inProgress: boolean,
  ): void {
    const activeAssistantId =
      useResolvedAssistantsStore.getState().activeAssistantId;
    if (activeAssistantId !== assistantId) return;

    if (!inProgress) {
      void this.probeReachability(assistantId);
      return;
    }

    if (this.state.kind === "self_hosted") {
      this.transition({ ...this.state, health: "upgrading" });
      return;
    }

    if (this.state.kind === "active" && this.state.isLocal) {
      this.transition({
        ...this.state,
        reachable: false,
        health: "upgrading",
      });
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
    this.cancelProbeTimer();
    this.cancelHealthHeartbeat();
    this.probeLoopAssistantId = null;
    this.reachabilityProbeInFlightIds.clear();
    this.clearErrorRetry(true);
    this.state = { kind: "loading" };
    this.generation = 0;
    this.ready = false;
    useAssistantLifecycleStore.setState({
      expectingFirstMessage: false,
      operationalStatusAssistantId: null,
    });
    this.inputs = {
      sessionStatus: "initializing",
      hasPlatformSession: false,
      queryClient: null as unknown as QueryClient,
    };
    useAssistantLifecycleStore.setState({ assistantState: this.state });
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
  }

  private setOperationalStatusAssistantId(assistantId: string | null): void {
    if (
      useAssistantLifecycleStore.getState().operationalStatusAssistantId ===
      assistantId
    ) {
      return;
    }
    useAssistantLifecycleStore.setState({
      operationalStatusAssistantId: assistantId,
    });
  }
}

export const lifecycleService = new AssistantLifecycleService();
