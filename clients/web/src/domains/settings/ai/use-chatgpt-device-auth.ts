import { useCallback, useEffect, useRef, useState } from "react";

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";
import { pollUntilSettled } from "@/utils/poll-until-settled";

import {
  cancelChatgptDeviceAuth,
  DeviceAuthUnsupportedError,
  pollChatgptDeviceAuthStatus,
  resolveChatgptConnection,
  startChatgptDeviceAuth,
} from "./chatgpt-subscription-api";

/**
 * Drives OpenAI's device-code sign-in for a ChatGPT subscription: mint a code,
 * show it while the user enters it on ChatGPT's own page, and poll the daemon
 * until the credential lands.
 *
 * The code survives the `error` phase when the daemon rejected it, because the
 * common rejection is an account that has device-code authorization switched
 * off: the user fixes that in ChatGPT's settings and the code they are looking
 * at is still the one to enter. An expired or never-minted code does not
 * survive, since there is nothing left to enter.
 */
export type ChatgptDeviceAuthPhase =
  | "idle"
  /** Minting the code. */
  | "starting"
  /** Code on screen, polling for the user to authorize it. */
  | "awaiting_authorization"
  | "connected"
  | "error";

/** Floor on the daemon's suggested cadence, so a bad value cannot busy-loop. */
const MIN_POLL_INTERVAL_SECONDS = 2;
/** Budget when `expires_at` is unparseable. Matches the copy on screen. */
const FALLBACK_WINDOW_MS = 15 * 60 * 1000;
/**
 * How long a code can sit unauthorized before the account-setting hint earns
 * its space. Long enough that a user who is simply reading the page is not
 * told they have a problem.
 */
const FRICTION_HINT_DELAY_MS = 30_000;

// Full catalog keys spelled out per error (rather than a template over the
// suffix) so `catalogs.test.ts` can see each key referenced in source.
const ERROR_MESSAGE_KEYS = {
  startFailed: "useChatgptDeviceAuth.startFailed",
  rejected: "useChatgptDeviceAuth.rejected",
  expired: "useChatgptDeviceAuth.expired",
} as const;

// Errors are held as catalog keys (or the daemon's own message) and translated
// at render with the reactive `t`, so a locale switch re-renders a displayed
// error in the new language along with the rest of the card.
type ChatgptDeviceAuthErrorState =
  | { key: keyof typeof ERROR_MESSAGE_KEYS }
  | { message: string };

export interface ChatgptDeviceCode {
  userCode: string;
  verificationUrl: string;
}

export interface UseChatgptDeviceAuthOptions {
  assistantId: string;
  /** Called once, with the stored subscription row, when the flow completes. */
  onConnected: (connection: ProviderConnection) => void;
}

export interface UseChatgptDeviceAuthResult {
  phase: ChatgptDeviceAuthPhase;
  /** The live code and where to enter it; `null` once it cannot be used. */
  code: ChatgptDeviceCode | null;
  error: string | null;
  /**
   * Whether to surface the "enable device code authorization" hint: the flow
   * has stalled or the daemon rejected the code, both of which that account
   * setting explains.
   */
  showAuthorizationHint: boolean;
  /**
   * The daemon has no device-auth route, so this flow cannot run at all and
   * the caller should offer the redirect-and-paste sign-in instead.
   */
  unsupported: boolean;
  /** Mint a code and begin polling. */
  start: () => Promise<void>;
  /** Drop the current flow and return to the explainer. */
  reset: () => void;
}

export function useChatgptDeviceAuth({
  assistantId,
  onConnected,
}: UseChatgptDeviceAuthOptions): UseChatgptDeviceAuthResult {
  const { t } = useTranslation("settings");
  const [phase, setPhase] = useState<ChatgptDeviceAuthPhase>("idle");
  const [code, setCode] = useState<ChatgptDeviceCode | null>(null);
  const [errorState, setErrorState] =
    useState<ChatgptDeviceAuthErrorState | null>(null);
  const [hintDue, setHintDue] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  // Bumped on every reset / new start and on unmount, so a poll loop from an
  // abandoned flow cannot write state after the user has moved on.
  const flowIdRef = useRef(0);
  const mountedRef = useRef(true);

  // The daemon-side flow still polling OpenAI, if any. It carries its own
  // assistant id so cancelling needs nothing from the current render.
  const liveFlowRef = useRef<{ assistantId: string; state: string } | null>(
    null,
  );

  // Dropping the flow on this side leaves the daemon polling OpenAI every few
  // seconds until the code expires, so tell it to stop.
  const cancelLiveFlow = useCallback(() => {
    const live = liveFlowRef.current;
    if (live === null) {
      return;
    }
    liveFlowRef.current = null;
    void cancelChatgptDeviceAuth(live.assistantId, live.state);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flowIdRef.current++;
      cancelLiveFlow();
    };
  }, [cancelLiveFlow]);

  const isStale = useCallback(
    (flowId: number) => flowIdRef.current !== flowId || !mountedRef.current,
    [],
  );

  // The stall hint is time on the clock, not a step in the flow, so it is armed
  // by the phase rather than by whoever entered it.
  useEffect(() => {
    if (phase !== "awaiting_authorization") {
      return;
    }
    const timer = setTimeout(() => setHintDue(true), FRICTION_HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const start = useCallback(async () => {
    const flowId = ++flowIdRef.current;
    setErrorState(null);
    setHintDue(false);
    setCode(null);
    setPhase("starting");

    let minted;
    try {
      minted = await startChatgptDeviceAuth(assistantId);
    } catch (err) {
      if (isStale(flowId)) {
        return;
      }
      // Nothing failed that the user can act on: this assistant simply has no
      // device-code route, so the caller swaps in the sign-in path it does.
      if (err instanceof DeviceAuthUnsupportedError) {
        setUnsupported(true);
        setPhase("idle");
        return;
      }
      setErrorState({ key: "startFailed" });
      setPhase("error");
      return;
    }
    if (isStale(flowId)) {
      return;
    }

    setCode({
      userCode: minted.userCode,
      verificationUrl: minted.verificationUrl,
    });
    setPhase("awaiting_authorization");
    liveFlowRef.current = { assistantId, state: minted.state };

    const outcome = await pollUntilSettled({
      poll: () => pollChatgptDeviceAuthStatus(assistantId, minted.state),
      intervalMs: pollIntervalMs(minted.intervalSeconds),
      maxAttempts: pollAttemptBudget(minted.expiresAt, minted.intervalSeconds),
      isStale: () => isStale(flowId),
    });
    if (outcome.kind === "abandoned") {
      return;
    }
    // The daemon settled this flow itself, so there is nothing left to cancel.
    if (liveFlowRef.current?.state === minted.state) {
      liveFlowRef.current = null;
    }
    if (outcome.kind === "connected") {
      const connection = await resolveChatgptConnection(assistantId);
      if (isStale(flowId)) {
        return;
      }
      setPhase("connected");
      onConnected(connection);
      return;
    }
    if (outcome.kind === "error") {
      // The code stays on screen: enabling the account setting the hint names
      // is usually all that stands between this code and a connection.
      setHintDue(true);
      setErrorState(
        outcome.message ? { message: outcome.message } : { key: "rejected" },
      );
      setPhase("error");
      return;
    }
    setCode(null);
    setErrorState({ key: "expired" });
    setPhase("error");
  }, [assistantId, isStale, onConnected]);

  const reset = useCallback(() => {
    flowIdRef.current++;
    cancelLiveFlow();
    setCode(null);
    setErrorState(null);
    setHintDue(false);
    setPhase("idle");
  }, [cancelLiveFlow]);

  const error =
    errorState === null
      ? null
      : "key" in errorState
        ? t(ERROR_MESSAGE_KEYS[errorState.key])
        : errorState.message;

  return {
    phase,
    code,
    error,
    showAuthorizationHint: hintDue,
    unsupported,
    start,
    reset,
  };
}

function pollIntervalMs(intervalSeconds: number): number {
  const seconds = Number(intervalSeconds);
  if (!Number.isFinite(seconds)) {
    return MIN_POLL_INTERVAL_SECONDS * 1000;
  }
  return Math.max(MIN_POLL_INTERVAL_SECONDS, seconds) * 1000;
}

/**
 * Enough attempts to cover the code's own lifetime and no more, so the loop
 * stops for the same reason the code does and the user is told it expired
 * instead of watching a spinner outlive it.
 */
function pollAttemptBudget(expiresAt: string, intervalSeconds: number): number {
  const expiry = Date.parse(expiresAt);
  const windowMs = Number.isFinite(expiry)
    ? expiry - Date.now()
    : FALLBACK_WINDOW_MS;
  return Math.max(1, Math.ceil(windowMs / pollIntervalMs(intervalSeconds)));
}
