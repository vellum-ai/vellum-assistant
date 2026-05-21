/**
 * React-bound driver for `useAssistantLifecycleStore`.
 *
 * Owns the three concerns that can't live inside framework-agnostic
 * store actions:
 *
 * 1. Initial check once auth is ready.
 * 2. Poll loop (3s) while the state machine is in `initializing` or
 *    `cleaning_up`.
 * 3. Stuck-initializing timeout — if the backend assigns an assistant
 *    but never promotes it to `active`, retire the row and hatch a
 *    replacement.
 *
 * Also wires React Router's `navigate` into the store via
 * `setRedirectHandler`, so the onboarding-gate redirect inside
 * `checkAssistant` stays SPA-native.
 */
import { useEffect } from "react";
import * as Sentry from "@sentry/react";

import { INITIALIZING_TIMEOUT_MS } from "@/assistant/lifecycle.js";
import { useAuthStore } from "@/stores/auth-store.js";
import {
  POLL_INTERVAL_MS,
  useAssistantLifecycleStore,
} from "@/stores/assistant-lifecycle-store.js";

interface UseAssistantLifecycleBootstrapOptions {
  /** Framework-agnostic redirect — typically React Router's `navigate`.
   *  Registered on the store so store actions can perform SPA
   *  redirects (the onboarding-gate hop) without capturing React
   *  context inside an action body. */
  onRedirect: (url: string) => void;
}

export function useAssistantLifecycleBootstrap({
  onRedirect,
}: UseAssistantLifecycleBootstrapOptions): void {
  const isLoggedIn = useAuthStore.use.isLoggedIn();
  const isLoading = useAuthStore.use.isLoading();
  const assistantStateKind = useAssistantLifecycleStore.use.assistantState().kind;
  const initializingCycle = useAssistantLifecycleStore.use.initializingCycle();

  // Register the navigate handler on the store and clear it on unmount
  // so a stale closure can't be invoked after the layout tears down.
  useEffect(() => {
    useAssistantLifecycleStore.getState().setRedirectHandler(onRedirect);
    return () => {
      useAssistantLifecycleStore.getState().setRedirectHandler(null);
    };
  }, [onRedirect]);

  // Initial check once auth is ready. Async — setState happens after
  // await, not synchronously.
  useEffect(() => {
    if (!isLoggedIn || isLoading) return;
    void useAssistantLifecycleStore.getState().checkAssistant();
  }, [isLoggedIn, isLoading]);

  // Poll while initializing or cleaning up. Re-runs every 3s until the
  // state machine exits those phases.
  useEffect(() => {
    if (
      assistantStateKind !== "initializing" &&
      assistantStateKind !== "cleaning_up"
    ) {
      return;
    }
    let cancelled = false;
    let pollHandle: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await useAssistantLifecycleStore.getState().checkAssistant();
      if (!cancelled) {
        pollHandle = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    pollHandle = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollHandle) {
        clearTimeout(pollHandle);
        pollHandle = null;
      }
    };
  }, [assistantStateKind]);

  // Stuck-initializing watchdog. Re-arms whenever a new "initializing"
  // cycle begins (the store bumps `initializingCycle` on every
  // hatchAndCheck), so a recovery hatch gets its own timeout window.
  useEffect(() => {
    if (assistantStateKind !== "initializing") return;
    const timeout = setTimeout(() => {
      Sentry.captureMessage("Assistant hatch stuck in initializing state", {
        level: "warning",
        extra: { timeoutMs: INITIALIZING_TIMEOUT_MS },
      });
      void useAssistantLifecycleStore.getState().recoverStuckInitializing();
    }, INITIALIZING_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [assistantStateKind, initializingCycle]);
}
