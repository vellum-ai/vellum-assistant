import { useAuthStore } from "@/stores/auth-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { isLocalMode } from "@/lib/local-mode";

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
   * `platformFeaturesInLocalMode` and its hydration state do NOT apply
   * to this branch — that flag gates daemon-side platform-API
   * interception in local mode, which is orthogonal to whether the
   * active assistant is platform-hosted.
   *
   * Defaults to `false` — the standard `"full" / "disabled" / "gated"`
   * behavior gated on `platformFeaturesInLocalMode`, hydration, and
   * `hasPlatformSession`.
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
 * `initializing`, `cleaning_up`, `retired`, `platform_hosted`,
 * `awaiting_version_selection`, `error`, and `active` with
 * `isLocal: false`).
 */
function useActiveAssistantIsSelfHosted(): boolean {
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  if (assistantState.kind === "self_hosted") return true;
  if (assistantState.kind === "active" && assistantState.isLocal) return true;
  return false;
}

export function usePlatformGate(
  options: PlatformGateOptions = {},
): PlatformGateState {
  // Atomic selectors — each returns a primitive so Zustand's default
  // `Object.is` snapshot equality is stable and `useSyncExternalStore`
  // does not loop. See CONVENTIONS.md § State management — `useShallow`
  // is not introduced in new code; atomic selectors avoid the need.
  const hasPlatformSession = useAuthStore.use.hasPlatformSession();
  const platformFeaturesOff = useAssistantFeatureFlagStore(
    (s) =>
      (s as Record<string, unknown>).platformFeaturesInLocalMode === false,
  );
  const hasHydrated = useAssistantFeatureFlagStore((s) => s.hasHydrated);
  const activeIsSelfHosted = useActiveAssistantIsSelfHosted();

  // Platform-hosted-only branch is fully self-contained: it only depends
  // on the active assistant's hosting and the platform session. The
  // local-mode feature flag and its hydration state DO NOT apply —
  // that flag gates the daemon-side API interceptor in local mode, which
  // is orthogonal to "is this UI's target assistant platform-hosted?"
  if (options.platformHostedOnly) {
    if (activeIsSelfHosted) return "gated";
    if (!hasPlatformSession) return "disabled";
    return "full";
  }

  const local = isLocalMode();
  if (local && platformFeaturesOff) return "gated";
  if (local && !hasHydrated) return "disabled";
  if (!hasPlatformSession) return "disabled";
  return "full";
}
