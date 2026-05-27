
import * as Sentry from "@sentry/react";
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { extractErrorMessage } from "@/lib/api-errors";
import {
  getAssistant,
  hatchAssistant,
  retireAssistantById,
} from "@/assistant/api";
import {
  buildInitializingTimeoutError,
  INITIALIZING_TIMEOUT_MS,
  isPlatformHostedDisabled,
  PLATFORM_HOSTED_DISABLED_MESSAGE,
  resolveAssistantLifecycleState,
  shouldRecoverFromHatchFailure,
} from "@/assistant/lifecycle";
import { resolveOnboardingRedirect } from "@/domains/onboarding/gate";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { routes } from "@/utils/routes";

const POLL_INTERVAL_MS = 3000;
const MAX_HATCH_RETRIES = 3;
const MAX_INITIALIZING_RECOVERIES = 3;

export type MaintenanceModeInfo = {
  enabled?: boolean;
};

/**
 * Discriminated union describing every phase the assistant can be in, from
 * initial load through active use and error states. Drives top-level
 * conditional rendering in the chat page.
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

interface UseAssistantLifecycleOptions {
  isLoggedIn: boolean;
  isLoading: boolean;
  isRetired: boolean;
  isNonProduction: boolean;
  /** Framework-agnostic redirect — called instead of router.replace(). */
  onRedirect: (url: string) => void;
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
 * Owns the full assistant lifecycle: hatching, polling, recovery, and
 * state transitions from "loading" through "active" / "error".
 *
 * Framework-agnostic — no Next.js imports. Routing is delegated to the
 * caller via the `onRedirect` callback.
 */
export function useAssistantLifecycle({
  isLoggedIn,
  isLoading,
  isRetired,
  isNonProduction,
  onRedirect,
}: UseAssistantLifecycleOptions): UseAssistantLifecycleReturn {
  const [assistantState, setAssistantState] = useState<AssistantState>({
    kind: "loading",
  });
  const [assistantId, setAssistantId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      const result = await hatchAssistant(version ? { version } : undefined);
      if (generation !== initializingGenerationRef.current) return;
      if (result.ok) {
        initializingAssistantIdRef.current = result.data.id;
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
      return;
    } finally {
      hatchingRef.current = false;
    }
    if (generation !== initializingGenerationRef.current) return;
    // Re-assert "initializing" so the poll loop restarts in case an
    // early poll returned 404 and switched state to "initializing"
    // while the hatch request was still in-flight.
    setAssistantState({ kind: "initializing" });
  }, []);

  const checkAssistant = useCallback(async () => {
    const generation = initializingGenerationRef.current;
    try {
      const result = await getAssistant();
      if (generation !== initializingGenerationRef.current) return;
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
        const onboardingRedirect = resolveOnboardingRedirect({
          intendedDestination: routes.assistant,
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
        // wait until after `getChatContext()` succeeds to set this,
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

      if (nextState.kind !== "active") {
        setAssistantState(nextState);
      }
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
  }, [hatchAndCheck]);

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
        const result = await getAssistant();
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

      const retireResult = await retireAssistantById(assistantIdToRetire);
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
  }, [hatchAndCheck]);

  // Initial check when auth is ready
  useEffect(() => {
    if (!isLoggedIn || isLoading) {
      return;
    }
    // Async check — setState happens after await, not synchronously
    checkAssistant();
  }, [isLoggedIn, isLoading, checkAssistant]);

  // Poll while initializing or cleaning up
  useEffect(() => {
    if (assistantState.kind !== "initializing" && assistantState.kind !== "cleaning_up") {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      await checkAssistant();
      if (!cancelled) {
        pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [assistantState.kind, checkAssistant]);

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
