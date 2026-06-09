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
  INITIALIZING_TIMEOUT_MS,
  resolveAssistantLifecycleState,
} from "@/assistant/lifecycle";
import {
  ASSISTANT_QUERY_KEY,
  assistantQueryKey,
} from "@/assistant/queries";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { AssistantState } from "@/assistant/types";
import { isGatewayAuthMode, getGatewayToken } from "@/lib/auth/gateway-session";
import {
  getSelectedAssistant,
  getLocalGatewayUrl,
} from "@/lib/local-mode";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { isAuthenticated, type SessionStatus } from "@/stores/session-status";

const PROBE_RETRY_DELAY_MS = 4_000;
const PROBE_RETRY_LIMIT_MS = 30_000;

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

  constructor() {
    subscribeAssistantUnreachable(() => this.onUnreachable());
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
        const store = useResolvedAssistantsStore.getState();
        const byOrg = store.selectedPlatformAssistantByOrg;
        for (const orgId of Object.keys(byOrg)) {
          if (byOrg[orgId] === selectedId) {
            store.setSelectedPlatformAssistant(orgId, null);
          }
        }
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
      this.transition({
        kind: "error",
        message: "Network error. Please check your connection and try again.",
      });
    }
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
    void this.probeReachability(result.data.id);
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
    const generation = this.generation;
    try {
      const result = await getAssistantHealthz(assistantId);
      if (generation !== this.generation) return;
      if (this.state.kind !== "active") return;
      this.transition({ ...this.state, reachable: result.ok });
    } catch {
      if (generation !== this.generation) return;
      if (this.state.kind !== "active") return;
      this.transition({ ...this.state, reachable: false });
    }
  }

  private cancelProbeTimer(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private startProbeLoop(assistantId: string): void {
    this.cancelProbeTimer();
    const startedAt = Date.now();
    const tick = async () => {
      if (this.state.kind !== "active") return;
      if (this.state.reachable === true) return;
      if (Date.now() - startedAt > PROBE_RETRY_LIMIT_MS) return;
      await this.probeReachability(assistantId);
      if (this.state.kind !== "active") return;
      if (this.state.reachable === true) return;
      if (Date.now() - startedAt > PROBE_RETRY_LIMIT_MS) return;
      this.probeTimer = setTimeout(() => void tick(), PROBE_RETRY_DELAY_MS);
    };
    this.probeTimer = setTimeout(() => void tick(), PROBE_RETRY_DELAY_MS);
  }

  private onUnreachable(): void {
    if (this.state.kind !== "active") return;
    this.transition({ ...this.state, reachable: false });
    const assistantId =
      useResolvedAssistantsStore.getState().activeAssistantId;
    if (assistantId) {
      this.startProbeLoop(assistantId);
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
    this.state = { kind: "loading" };
    this.generation = 0;
    this.ready = false;
    useAssistantLifecycleStore.setState({ expectingFirstMessage: false });
    this.inputs = {
      sessionStatus: "initializing",
      hasPlatformSession: false,
      queryClient: null as unknown as QueryClient,
    };
    useAssistantLifecycleStore.setState({ assistantState: this.state });
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
  }
}

export const lifecycleService = new AssistantLifecycleService();
