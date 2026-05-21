/**
 * Zustand store owning the full assistant lifecycle state machine —
 * hatching, polling, recovery, and transitions from "loading" through
 * "active" / "error". Reactive UI state (`assistantState`, `assistantId`)
 * and internal counters live together so actions can read and mutate
 * them via `set`/`get` without ref-juggling.
 *
 * The React-bound effects (initial check, poll-while-initializing,
 * stuck-initializing timeout) live in
 * `@/hooks/use-assistant-lifecycle-bootstrap.ts` — this store stays
 * framework-agnostic.
 *
 * Cross-cutting handlers that can't be captured inside an action
 * (React Router's `navigate`) are registered at bootstrap time via
 * `setRedirectHandler` and invoked through the store as `_redirect`.
 *
 * References:
 * - https://zustand.docs.pmnd.rs/
 * - https://zustand.docs.pmnd.rs/guides/auto-generating-selectors
 */

import * as Sentry from "@sentry/react";
import { create } from "zustand";

import { extractErrorMessage } from "@/lib/api-errors.js";
import {
  getAssistant,
  hatchAssistant,
  retireAssistantById,
} from "@/assistant/api.js";
import {
  buildInitializingTimeoutError,
  isPlatformHostedDisabled,
  PLATFORM_HOSTED_DISABLED_MESSAGE,
  resolveAssistantLifecycleState,
  shouldRecoverFromHatchFailure,
} from "@/assistant/lifecycle.js";
import { resolveOnboardingRedirect } from "@/domains/onboarding/gate.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { useEnvironmentStore } from "@/lib/environment/environment-store.js";
import { routes } from "@/utils/routes.js";
import { createSelectors } from "@/utils/create-selectors.js";

export const POLL_INTERVAL_MS = 3000;
export const MAX_HATCH_RETRIES = 3;
export const MAX_INITIALIZING_RECOVERIES = 3;

export type MaintenanceModeInfo = {
  enabled?: boolean;
};

/**
 * Discriminated union describing every phase the assistant can be in,
 * from initial load through active use and error states. Drives
 * top-level conditional rendering in the chat page.
 */
export type AssistantState =
  | { kind: "loading" }
  | { kind: "initializing" }
  | { kind: "cleaning_up" }
  | { kind: "retired" }
  | { kind: "platform_hosted" }
  | { kind: "self_hosted" }
  | { kind: "awaiting_version_selection" }
  | { kind: "active"; isLocal: boolean; maintenanceMode?: MaintenanceModeInfo }
  | { kind: "error"; message: string };

/**
 * `isRetired` is hardcoded `false` at the only caller today. Kept as a
 * module constant so the read site inside `checkAssistant` mirrors the
 * original hook's `isRetiredRef` semantics; flipping a future
 * user-store flag is a single-line change.
 */
const IS_RETIRED = false;

export interface AssistantLifecycleState {
  assistantState: AssistantState;
  assistantId: string | null;
  /** Bumps each time a new "initializing" cycle starts. Used by the
   *  React-bound stuck-recovery effect to re-arm its timeout. */
  initializingCycle: number;
  /** True from the moment the first post-hatch send should be an
   *  auto-greet until the conversation loader consumes it. Read by the
   *  send-message and conversation-loader domains. */
  autoGreet: boolean;
}

export interface AssistantLifecycleActions {
  /** Re-check the assistant status from the server. Exposed for the
   *  visibility-change handler, the poll loop, and other external
   *  effects. */
  checkAssistant: () => Promise<void>;
  /** Reset all retry/recovery counters and re-check. For the error
   *  screen "Try again" button. */
  retryAssistant: () => void;
  /** Reset hatch retries, arm auto-greet, and hatch with the given
   *  version. For the version-selection screen. */
  hatchVersion: (version?: string) => void;
  setAssistantId: (id: string | null) => void;
  setAutoGreet: (value: boolean) => void;
  /** Internal — invoked by the stuck-initializing timeout effect in
   *  the bootstrap hook. Retires the stuck assistant row and hatches a
   *  replacement (up to `MAX_INITIALIZING_RECOVERIES` times). */
  recoverStuckInitializing: () => Promise<void>;
  /** Register the React Router navigate function so store actions can
   *  perform SPA redirects (e.g. the onboarding gate) without
   *  capturing React context. */
  setRedirectHandler: (handler: ((url: string) => void) | null) => void;
}

export type AssistantLifecycleStore = AssistantLifecycleState &
  AssistantLifecycleActions;

// ---------------------------------------------------------------------------
// Module-level mutable state — counters/flags that the original hook
// kept in refs. Held outside `set()` so they don't trigger re-renders
// and so actions can read them synchronously without `get()` indirection.
// ---------------------------------------------------------------------------

let hatching = false;
let hatchRetryCount = 0;
let initializingAssistantId: string | null = null;
let initializingRecoveryCount = 0;
let hatchingVersion: string | undefined = undefined;
/**
 * Bumped when an "initializing" cycle times out. Async work that
 * captured a prior value compares against this and drops its response,
 * so stale "initializing" answers can't revive the spinner after
 * timeout -> error.
 */
let initializingGeneration = 0;
let redirectHandler: ((url: string) => void) | null = null;

/**
 * Test-only reset of every module-level counter. Lives in the same
 * file so tests don't need to reach into private state.
 */
export function resetAssistantLifecycleStoreForTests(): void {
  hatching = false;
  hatchRetryCount = 0;
  initializingAssistantId = null;
  initializingRecoveryCount = 0;
  hatchingVersion = undefined;
  initializingGeneration = 0;
  redirectHandler = null;
  useAssistantLifecycleStore.setState({
    assistantState: { kind: "loading" },
    assistantId: null,
    initializingCycle: 0,
    autoGreet: false,
  });
}

const useAssistantLifecycleStoreBase = create<AssistantLifecycleStore>()(
  (set, get) => ({
    assistantState: { kind: "loading" },
    assistantId: null,
    initializingCycle: 0,
    autoGreet: false,

    setAssistantId: (id) => set({ assistantId: id }),
    setAutoGreet: (value) => set({ autoGreet: value }),
    setRedirectHandler: (handler) => {
      redirectHandler = handler;
    },

    checkAssistant: async () => {
      const generation = initializingGeneration;
      try {
        const result = await getAssistant();
        if (generation !== initializingGeneration) return;
        const nextState = resolveAssistantLifecycleState(result);
        if (result.ok && nextState.kind === "initializing") {
          initializingAssistantId = result.data.id;
        } else if (nextState.kind !== "initializing") {
          initializingAssistantId = null;
        }
        if (nextState.kind === "auto_hatch") {
          // If we just retired, show the retired screen instead of auto-hatching.
          if (IS_RETIRED) {
            set({ assistantState: { kind: "retired" } });
            return;
          }
          // New signups without completed onboarding should land on
          // `/onboarding/privacy` before we hatch an assistant for them.
          const onboardingRedirect = resolveOnboardingRedirect({
            intendedDestination: routes.assistant,
          });
          if (onboardingRedirect) {
            redirectHandler?.(onboardingRedirect);
            return;
          }
          // In nonprod, let the user pick a release version before hatching.
          if (useEnvironmentStore.getState().isNonProduction) {
            set({ assistantState: { kind: "awaiting_version_selection" } });
            return;
          }
          // No assistant exists — auto-hatch using managed credentials.
          set({ autoGreet: true });
          await hatchAndCheck(set);
          return;
        }

        if (nextState.kind === "active" && result.ok) {
          const mm = result.data.maintenance_mode;
          initializingRecoveryCount = 0;
          hatchingVersion = undefined;
          // Set the assistant id here, before any pod-facing fetch runs.
          // The `init` effect downstream only fetches conversations once
          // `assistantState.kind === "active"`, and that fetch is what
          // the unreachable-bus interceptor is meant to notice. If we
          // wait until after `getChatContext()` succeeds to set this,
          // the reachability hook's probe() has no target assistant
          // when the 503 arrives and the connecting overlay never
          // shows.
          set({
            assistantId: result.data.id,
            assistantState: {
              kind: "active",
              isLocal: result.data.is_local ?? false,
              maintenanceMode: {
                enabled: mm?.enabled,
              },
            },
          });
          return;
        }

        if (nextState.kind !== "active") {
          set({ assistantState: nextState });
        }
      } catch (err) {
        console.error("Error checking assistant status:", err);
        Sentry.captureException(err, {
          tags: { context: "check_assistant" },
        });
        if (generation !== initializingGeneration) return;
        set({
          assistantState: {
            kind: "error",
            message:
              "Network error. Please check your connection and try again.",
          },
        });
      }
    },

    retryAssistant: () => {
      hatchRetryCount = 0;
      initializingRecoveryCount = 0;
      void get().checkAssistant();
    },

    hatchVersion: (version) => {
      hatchRetryCount = 0;
      set({ autoGreet: true });
      void hatchAndCheck(set, version);
    },

    recoverStuckInitializing: async () => {
      if (initializingRecoveryCount >= MAX_INITIALIZING_RECOVERIES) {
        initializingGeneration++;
        set({ assistantState: buildInitializingTimeoutError() });
        return;
      }

      initializingRecoveryCount++;
      initializingGeneration++;
      const generation = initializingGeneration;

      try {
        let assistantIdToRetire = initializingAssistantId;
        if (!assistantIdToRetire) {
          const result = await getAssistant();
          if (generation !== initializingGeneration) return;
          if (result.ok && result.data.status === "initializing") {
            assistantIdToRetire = result.data.id;
          } else {
            const nextState = resolveAssistantLifecycleState(result);
            initializingAssistantId = null;
            if (nextState.kind === "auto_hatch") {
              await hatchAndCheck(set, hatchingVersion);
            } else if (nextState.kind === "active" && result.ok) {
              const mm = result.data.maintenance_mode;
              initializingRecoveryCount = 0;
              set({
                assistantId: result.data.id,
                assistantState: {
                  kind: "active",
                  isLocal: result.data.is_local ?? false,
                  maintenanceMode: {
                    enabled: mm?.enabled,
                  },
                },
              });
            } else if (nextState.kind !== "active") {
              set({ assistantState: nextState });
            }
            return;
          }
        }

        // Prevent the poll loop from calling hatchAndCheck() while we
        // retire the stuck assistant. Without this, a poll that
        // observes the 404 (after the retire takes effect on the
        // backend but before our own hatchAndCheck creates the
        // replacement) races to create a duplicate assistant.
        hatching = true;

        const retireResult = await retireAssistantById(assistantIdToRetire);
        if (generation !== initializingGeneration) {
          hatching = false;
          return;
        }
        if (!retireResult.ok && retireResult.status !== 404) {
          hatching = false;
          Sentry.captureMessage(
            "Failed to retire stuck initializing assistant",
            {
              level: "warning",
              extra: {
                status: retireResult.status,
                error: retireResult.error,
              },
            },
          );
          set({ assistantState: buildInitializingTimeoutError() });
          return;
        }

        initializingAssistantId = null;
        set({ assistantId: null });
        hatching = false;
        await hatchAndCheck(set, hatchingVersion);
      } catch (err) {
        hatching = false;
        Sentry.captureException(err, {
          tags: { context: "recover_stuck_initializing_assistant" },
        });
        if (generation !== initializingGeneration) return;
        set({ assistantState: buildInitializingTimeoutError() });
      }
    },
  }),
);

/**
 * Hatch a new assistant and immediately settle to "initializing" so
 * the poll loop drives the rest of the lifecycle. Out-of-line so
 * `checkAssistant`, `hatchVersion`, and `recoverStuckInitializing`
 * share one implementation.
 */
async function hatchAndCheck(
  set: (
    partial:
      | Partial<AssistantLifecycleStore>
      | ((s: AssistantLifecycleStore) => Partial<AssistantLifecycleStore>),
  ) => void,
  version?: string,
): Promise<void> {
  if (hatching) return;

  if (hatchRetryCount >= MAX_HATCH_RETRIES) {
    set({
      assistantState: {
        kind: "error",
        message:
          "Failed to start your assistant after multiple attempts. Please refresh the page to try again.",
      },
    });
    return;
  }

  hatching = true;
  hatchingVersion = version;
  const generation = initializingGeneration;
  set((s) => ({
    initializingCycle: s.initializingCycle + 1,
    assistantState: { kind: "initializing" },
  }));
  try {
    const result = await hatchAssistant(version ? { version } : undefined);
    if (generation !== initializingGeneration) return;
    if (result.ok) {
      initializingAssistantId = result.data.id;
    }
    if (!result.ok) {
      hatchRetryCount += 1;
      Sentry.captureMessage("Hatch request failed", {
        level: "warning",
        extra: {
          status: result.status,
          error: result.error,
          attempt: hatchRetryCount,
        },
      });
      // Capacity / kill-switch from the backend (platform-hosted-enabled
      // flag is off). Surface the tailored message instead of treating
      // this as a recoverable 5xx — retrying just burns the
      // MAX_HATCH_RETRIES budget and ends in a generic error.
      if (isPlatformHostedDisabled(result.status, result.error)) {
        set({
          assistantState: {
            kind: "error",
            message: PLATFORM_HOSTED_DISABLED_MESSAGE,
          },
        });
        return;
      }
      if (shouldRecoverFromHatchFailure(result.status)) {
        set({ assistantState: { kind: "initializing" } });
        return;
      }

      set({
        assistantState: {
          kind: "error",
          message: extractErrorMessage(
            result.error,
            undefined,
            "Failed to start your assistant. Please refresh the page to try again.",
          ),
        },
      });
      return;
    }
    hatchRetryCount = 0;
  } catch (err) {
    hatchRetryCount += 1;
    Sentry.captureException(err, {
      tags: { context: "hatch_assistant" },
    });
    if (generation !== initializingGeneration) return;
    set({ assistantState: { kind: "initializing" } });
    return;
  } finally {
    hatching = false;
  }
  if (generation !== initializingGeneration) return;
  // Re-assert "initializing" so the poll loop restarts in case an
  // early poll returned 404 and switched state to "initializing"
  // while the hatch request was still in-flight.
  set({ assistantState: { kind: "initializing" } });
}

export const useAssistantLifecycleStore = createSelectors(
  useAssistantLifecycleStoreBase,
);

/**
 * Non-React snapshot of the current `autoGreet` flag for callers that
 * still want a `MutableRefObject<boolean>`-shaped interface during
 * migration. Reads through `getState()` so it never subscribes.
 */
export function isAutoGreetArmed(): boolean {
  return useAssistantLifecycleStore.getState().autoGreet;
}

/**
 * Read auth flags via the store so action bodies stay framework-agnostic.
 * Exported for the bootstrap hook's effect dependencies.
 */
export function isAssistantBootstrapReady(): boolean {
  const auth = useAuthStore.getState();
  return auth.isLoggedIn && !auth.isLoading;
}
