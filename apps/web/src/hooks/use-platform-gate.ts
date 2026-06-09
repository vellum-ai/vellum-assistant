import { useHasPlatformSession } from "@/stores/auth-store";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { isLocalMode, isPlatformDisabled } from "@/lib/local-mode";

export type PlatformGateState = "full" | "disabled" | "gated";

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
function useActiveAssistantIsSelfHosted(): boolean {
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  if (assistantState.kind === "self_hosted") return true;
  if (assistantState.kind === "active" && assistantState.isLocal) return true;
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
  if (assistantState.kind === "active" && !assistantState.isLocal) return true;
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

export function usePlatformGate(
  options: PlatformGateOptions = {},
): PlatformGateState {
  // Atomic selectors — each returns a primitive so Zustand's default
  // `Object.is` snapshot equality is stable and `useSyncExternalStore`
  // does not loop. See CONVENTIONS.md § State management — `useShallow`
  // is not introduced in new code; atomic selectors avoid the need.
  // Read the optimistic value: `"present"` is a live session, while both
  // `"absent"` and the pre-settle `"unknown"` gate the surface. A re-probe
  // keeps the last `"present"`/`"absent"` until the new result lands, so this
  // doesn't flicker to `"disabled"` on app resume.
  const hasPlatformSession = useHasPlatformSession();
  const platformDisabled = isPlatformDisabled();
  const activeIsSelfHosted = useActiveAssistantIsSelfHosted();

  // Platform-hosted-only branch is fully self-contained: it only depends
  // on the active assistant's hosting and the platform session. The
  // VELLUM_DISABLE_PLATFORM env var does NOT apply — it gates the
  // daemon-side API interceptor in local mode, which is orthogonal to
  // "is this UI's target assistant platform-hosted?"
  if (options.platformHostedOnly) {
    if (activeIsSelfHosted) return "gated";
    if (!hasPlatformSession) return "disabled";
    return "full";
  }

  const local = isLocalMode();
  if (local && platformDisabled) return "gated";
  if (!hasPlatformSession) return "disabled";
  return "full";
}
