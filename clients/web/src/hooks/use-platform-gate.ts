import { useEffect, useState } from "react";

import {
  useHasPlatformSession,
  useIsPlatformSessionSettled,
} from "@/stores/auth-store";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { isLocalMode, isPlatformDisabled } from "@/lib/local-mode";

/**
 * How a platform-dependent UI surface should behave, given the app mode,
 * platform session, and active assistant:
 *
 *   - `"full"`     — render the feature and let the user use it.
 *   - `"disabled"` — render the feature but block interaction (e.g. show
 *                    it greyed-out behind a "sign in to use this" prompt).
 *                    Reached when the platform is reachable but there is
 *                    no platform session.
 *   - `"gated"`    — hide the feature entirely; it has no meaning in this
 *                    context — local mode with the platform API disabled,
 *                    or (for `platformHostedOnly` surfaces) a self-hosted
 *                    active assistant.
 */
export type PlatformGateState = "full" | "disabled" | "gated";

/**
 * {@link PlatformGateState} plus the pre-settle window as its own value.
 *
 *   - `"pending"` — the platform-session probe has not settled, so "no session"
 *     is not an answer yet, only the absence of one. A surface whose decision
 *     is irreversible for the user (leaving the route, dropping stashed state,
 *     bouncing a paid entry point) must hold here rather than read it as
 *     `"disabled"`.
 *
 * {@link usePlatformGate} collapses `"pending"` into `"disabled"`: the surfaces
 * it serves render either way and correct themselves when the probe lands, so
 * an extra state would only add a branch nothing acts on.
 */
export type PlatformGateStateWithPending = PlatformGateState | "pending";

/**
 * How long {@link usePlatformGateWithPending} holds `"pending"` before deciding
 * on `"disabled"`.
 *
 * Every path that completes settles the probe itself; this bounds the one that
 * never completes. The fallback matches the route guard's: an unsettled session
 * means "no decision yet" and a settled-absent one means "no platform account",
 * so forcing the decision can only turn a non-decision into that documented
 * answer.
 */
export const PLATFORM_SESSION_SETTLE_TIMEOUT_MS = 5_000;

export interface PlatformGateOptions {
  /**
   * When `true`, the feature is platform-hosted only — gate it whenever
   * the **active assistant** is self-hosted, regardless of platform
   * session or feature-flag value. Use for UI surfaces that manage
   * Vellum-hosted infrastructure (plan/billing tier, devices, machine
   * sizing, release channels, sleep policy, system events) which have
   * no meaningful behavior on a self-hosted assistant.
   *
   * The decision is "is the active assistant self-hosted?" — not "is
   * the app running in local mode?" Two cases this matters for:
   *
   *   1. A **local-mode app** can be acting on a platform-hosted
   *      assistant (lockfile entry with `cloud === "vellum"`). The
   *      platform billing/plan UI for that assistant IS meaningful.
   *   2. A **platform-mode app** can be acting on a self-hosted
   *      assistant — when the platform API returns `is_local: true`,
   *      `resolveAssistantLifecycleState` projects `kind: "self_hosted"`
   *      and the user is effectively connected to a daemon. The
   *      platform billing/plan UI for that assistant is NOT meaningful.
   *
   * The reactive source is `useAssistantLifecycleStore.assistantState`,
   * which is written by the lifecycle service from server resolutions
   * and gateway-auth short-circuits and covers both cases above.
   *
   * Truth table:
   *
   * | Active assistant            | Platform session | Result       |
   * | --------------------------- | ---------------- | ------------ |
   * | platform-hosted             | yes              | `"full"`     |
   * | platform-hosted             | no               | `"disabled"` |
   * | self-hosted                 | any              | `"gated"`    |
   * | none resolved (loading etc) | yes              | `"full"`     |
   * | none resolved               | no               | `"disabled"` |
   *
   * `VELLUM_DISABLE_PLATFORM` does NOT apply to this branch — that
   * env var gates daemon-side platform-API interception in local mode,
   * which is orthogonal to whether the active assistant is
   * platform-hosted.
   *
   * Defaults to `false` — the standard `"full" / "disabled" / "gated"`
   * behavior gated on `VELLUM_DISABLE_PLATFORM` and the platform
   * session.
   */
  platformHostedOnly?: boolean;
}

export interface PendingPlatformGateOptions extends PlatformGateOptions {
  /**
   * How long `"pending"` may hold before the gate decides on `"disabled"`.
   * Defaults to {@link PLATFORM_SESSION_SETTLE_TIMEOUT_MS}; tests shorten it.
   */
  settleTimeoutMs?: number;
}

/**
 * Is the currently-active assistant self-hosted? Reads from
 * `useAssistantLifecycleStore` so the answer reactively flips as the
 * lifecycle service projects new server resolutions or gateway-auth
 * short-circuits.
 *
 * Returns `true` when:
 *   - the server resolved `is_local: true` → `kind: "self_hosted"`, or
 *   - the gateway-auth short-circuit fired in local mode →
 *     `kind: "active", isLocal: true`.
 *
 * Returns `false` for every other lifecycle state (`loading`,
 * `initializing`, `cleaning_up`, `error`, and `active` with
 * `isLocal: false`).
 */
export function useActiveAssistantIsSelfHosted(): boolean {
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  if (assistantState.kind === "self_hosted") {
    return true;
  }
  if (assistantState.kind === "active" && assistantState.isLocal) {
    return true;
  }
  return false;
}

/**
 * Is the active assistant POSITIVELY resolved as platform-hosted?
 *
 * Use this to gate network fetches that must not fire against a
 * self-hosted assistant. `usePlatformGate({ platformHostedOnly: true })`
 * deliberately returns `"full"` during the lifecycle `loading` window
 * (when no server resolution has landed yet) so UI doesn't flicker to
 * `gated` on a fresh deep-link — fine for rendering, NOT fine for
 * kicking off a doomed platform-API request on a settings route that
 * is not mounted under `<ActiveAssistantGate>`.
 *
 * This helper takes the stricter side: returns `true` only when the
 * lifecycle has positively projected a platform-hosted assistant:
 *   - `kind: "active"` with `isLocal: false`.
 *
 * Returns `false` for every other state — including `loading`,
 * `initializing`, `cleaning_up`, `self_hosted`, `error`,
 * and `active` with `isLocal: true`.
 *
 * Pair with the gate value in a query's `enabled`:
 *
 * ```ts
 * const platformGate = usePlatformGate({ platformHostedOnly: true });
 * const isPlatformHosted = useActiveAssistantIsPlatformHosted();
 * useQuery({
 *   ...someOrgScopedQueryOptions(),
 *   enabled: platformGate === "full" && isPlatformHosted,
 * });
 * ```
 */
export function useActiveAssistantIsPlatformHosted(): boolean {
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  if (assistantState.kind === "active" && !assistantState.isLocal) {
    return true;
  }
  return false;
}

/**
 * Is the active assistant's hosting still being resolved?
 *
 * Use this to compute the **race-window predicate** `isResolving` on
 * platform-hosted-only surfaces. `useActiveAssistantIsPlatformHosted()`
 * returns `false` for both *"resolving"* states AND *"already-resolved
 * non-hosted"* states (`error`, `self_hosted`,
 * `active`+`isLocal:true`). Conflating those breaks UX:
 * a permanent spinner / permanent disabled button in already-decided
 * non-hosted states is not "still loading," it's "no hosted assistant."
 *
 * This helper isolates the *genuinely loading* state — `kind: "loading"`,
 * before any server resolution or short-circuit has landed. That's the
 * only state where the gate intentionally returns `"full"` despite
 * unknown hosting (to avoid chrome flicker on deep-links). Pair it with
 * the gate value to build `isResolving`:
 *
 * ```ts
 * const platformGate = usePlatformGate({ platformHostedOnly: true });
 * const isResolving =
 *   platformGate === "full" && useActiveAssistantLifecycleIsLoading();
 * ```
 *
 * Already-resolved non-hosted lifecycle kinds (`error`)
 * should fall through to whatever empty /
 * error UX the surface already has — the gate's `"gated"` branch is
 * reserved for *self-hosted* assistants, and these states aren't
 * self-hosted, they're absent / broken. Don't gate them as "still
 * loading."
 *
 * Returns `true` for `kind: "loading"` and transitional states
 * (`initializing`, `cleaning_up`) where we don't yet know the terminal
 * outcome. Returns `false` for already-resolved non-hosted states
 * (`error`).
 */
export function useActiveAssistantLifecycleIsLoading(): boolean {
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  return (
    assistantState.kind === "loading" ||
    assistantState.kind === "initializing" ||
    assistantState.kind === "cleaning_up"
  );
}

/**
 * Resolve how a platform-dependent UI surface should behave — see
 * {@link PlatformGateState} for what each result means.
 *
 * Two modes, selected by `options.platformHostedOnly`:
 *
 *   - **Default** (most surfaces): gate on whether the app can reach the
 *     platform at all. `"gated"` only when the app is in local mode AND
 *     `VELLUM_DISABLE_PLATFORM` is set (the platform API is turned off);
 *     otherwise the platform session decides:
 *
 *     | App mode                          | Platform session | Result       |
 *     | --------------------------------- | ---------------- | ------------ |
 *     | local + `VELLUM_DISABLE_PLATFORM` | any              | `"gated"`    |
 *     | otherwise                         | no               | `"disabled"` |
 *     | otherwise                         | yes              | `"full"`     |
 *
 *   - **`platformHostedOnly: true`**: for surfaces that only make sense
 *     against a Vellum-hosted assistant (billing, devices, sleep policy,
 *     …). Gates on the active assistant's hosting instead of the app
 *     mode. See {@link PlatformGateOptions.platformHostedOnly} for its
 *     truth table and rationale.
 *
 * Both modes read the platform-session pre-settle window as `"disabled"`:
 * these surfaces render either way and re-render when the probe lands. A
 * surface that instead acts irreversibly on `"disabled"` wants
 * {@link usePlatformGateWithPending}, which keeps that window distinct.
 */
export function usePlatformGate(
  options: PlatformGateOptions = {},
): PlatformGateState {
  const state = usePlatformGateDecision(options);
  return state === "pending" ? "disabled" : state;
}

/**
 * {@link usePlatformGate} with the pre-settle window kept distinct — see
 * {@link PlatformGateStateWithPending}.
 *
 * `"pending"` is bounded: it is held for at most `settleTimeoutMs` (default
 * {@link PLATFORM_SESSION_SETTLE_TIMEOUT_MS}) and then decides on `"disabled"`,
 * so a probe that never settles still reaches an answer instead of holding a
 * surface on its loading state forever.
 *
 * Use this only where reading the pre-settle window as `"disabled"` would take
 * an action the user can't undo — leaving the route, clearing stashed state,
 * bouncing a paid entry point. Everything else wants {@link usePlatformGate},
 * which renders now and re-renders when the probe lands.
 */
export function usePlatformGateWithPending(
  options: PendingPlatformGateOptions = {},
): PlatformGateStateWithPending {
  const state = usePlatformGateDecision(options);
  const settleDeadlinePassed = useDeadlinePassed(
    state === "pending",
    options.settleTimeoutMs ?? PLATFORM_SESSION_SETTLE_TIMEOUT_MS,
  );
  if (state === "pending" && settleDeadlinePassed) {
    return "disabled";
  }
  return state;
}

/**
 * The gate's decision tree, with the platform-session pre-settle window
 * reported as `"pending"`. The two public hooks differ only in what they do
 * with that value.
 */
function usePlatformGateDecision(
  options: PlatformGateOptions,
): PlatformGateStateWithPending {
  // Atomic selectors — each returns a primitive so Zustand's default
  // `Object.is` snapshot equality is stable and `useSyncExternalStore`
  // does not loop. See CONVENTIONS.md § State management — `useShallow`
  // is not introduced in new code; atomic selectors avoid the need.
  //
  // Gate on the bare platform-session signal — deliberately not a per-assistant
  // reachability check, which would fork on hosting type and change the
  // self-hosted rows (states 3–5) of the truth table.
  const hasPlatformSession = useHasPlatformSession();
  const platformSessionSettled = useIsPlatformSessionSettled();
  const platformDisabled = isPlatformDisabled();
  const activeIsSelfHosted = useActiveAssistantIsSelfHosted();

  // Only the negative branch consults the settle: `"present"` is a settled
  // value by construction, so a live session is decisive on its own.
  const noSession: PlatformGateStateWithPending = platformSessionSettled
    ? "disabled"
    : "pending";

  // Platform-hosted-only branch is fully self-contained: it only depends
  // on the active assistant's hosting and the platform session. The
  // VELLUM_DISABLE_PLATFORM env var does NOT apply — it gates the
  // daemon-side API interceptor in local mode, which is orthogonal to
  // "is this UI's target assistant platform-hosted?"
  if (options.platformHostedOnly) {
    if (activeIsSelfHosted) {
      return "gated";
    }
    if (!hasPlatformSession) {
      return noSession;
    }
    return "full";
  }

  const local = isLocalMode();
  if (local && platformDisabled) {
    return "gated";
  }
  if (!hasPlatformSession) {
    return noSession;
  }
  return "full";
}

/**
 * `true` once `timeoutMs` has elapsed with `armed` continuously set. Disarming
 * cancels the timer and clears the result, so a window that reopens gets a
 * fresh deadline rather than an already-expired one.
 */
function useDeadlinePassed(armed: boolean, timeoutMs: number): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    if (!armed) {
      setPassed(false);
      return;
    }
    const timer = setTimeout(() => setPassed(true), timeoutMs);
    return () => {
      clearTimeout(timer);
    };
  }, [armed, timeoutMs]);
  return passed;
}
