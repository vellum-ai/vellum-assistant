import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Zustand store for managed-OAuth connects that are waiting on the user.
 *
 * The authoritative record of a connection is the platform's connections list,
 * so the only thing this holds is what the server does not know yet: an
 * authorization is open somewhere and which connections existed before it
 * started.
 *
 * It lives at module scope because the `oauth_connect` card remounts as the
 * chat transcript re-renders, and a per-component flag resets with it. A
 * remounted card reads the attempt back out of here, so a second trigger
 * cannot open a second popup (JARVIS-1286). Plain data rather than an
 * in-flight promise, so there is no listener lifetime to keep in step with a
 * component's.
 *
 * In-memory only: a reload drops the attempt, and the connections query alone
 * decides what the UI shows after that.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */
export interface OAuthConnectAttempt {
  /** Correlates the popup's completion payload with this attempt. */
  requestId: string;
  /** When the authorization opened, used to stop polling for a stale attempt. */
  startedAt: number;
  /**
   * The id the PLATFORM knows this assistant by. Absent until the identity
   * resolves: the attempt is recorded before that, so the setup requests
   * cannot race a second authorization into the same slot.
   */
  platformAssistantId?: string;
  /**
   * Connection signatures captured before authorization. A grant is only new
   * when it differs from these, which is what keeps an account the user
   * already connected from reading as the one they just authorized. Absent
   * for the same reason as `platformAssistantId`.
   */
  baselineSignatures?: ReadonlyMap<string, string>;
  /**
   * When the provider's callback reported success. The connections list is
   * still the place the granted account comes from, but the callback is a
   * request-scoped answer from our own page, so the flow stops waiting on the
   * list once it has one.
   */
  confirmedAt?: number;
}

/** Attempts keyed by `${assistantId}::${providerKey}`. */
interface OAuthConnectAttemptState {
  attempts: Readonly<Record<string, OAuthConnectAttempt>>;
}

interface OAuthConnectAttemptActions {
  startAttempt: (key: string, attempt: OAuthConnectAttempt) => void;
  /**
   * Fill in what the setup requests resolved. Ignored when the slot no longer
   * holds `requestId`, so a dismissed and restarted attempt is not overwritten
   * by the one it replaced.
   */
  readyAttempt: (
    key: string,
    requestId: string,
    resolved: Required<
      Pick<OAuthConnectAttempt, "platformAssistantId" | "baselineSignatures">
    >,
  ) => void;
  /** Record that the provider's callback reported success for `requestId`. */
  confirmAttempt: (key: string, requestId: string) => void;
  clearAttempt: (key: string) => void;
}

export function oauthConnectAttemptKey(
  assistantId: string,
  providerKey: string,
): string {
  return `${assistantId}::${providerKey}`;
}

const useOAuthConnectAttemptStoreBase = create<
  OAuthConnectAttemptState & OAuthConnectAttemptActions
>()((set) => ({
  attempts: {},

  startAttempt: (key, attempt) =>
    set((state) => ({ attempts: { ...state.attempts, [key]: attempt } })),

  readyAttempt: (key, requestId, resolved) =>
    set((state) => {
      const current = state.attempts[key];
      if (!current || current.requestId !== requestId) {
        return state;
      }
      return {
        attempts: { ...state.attempts, [key]: { ...current, ...resolved } },
      };
    }),

  confirmAttempt: (key, requestId) =>
    set((state) => {
      const current = state.attempts[key];
      if (!current || current.requestId !== requestId || current.confirmedAt) {
        return state;
      }
      return {
        attempts: {
          ...state.attempts,
          [key]: { ...current, confirmedAt: Date.now() },
        },
      };
    }),

  clearAttempt: (key) =>
    set((state) => {
      if (!(key in state.attempts)) {
        return state;
      }
      const { [key]: _removed, ...rest } = state.attempts;
      return { attempts: rest };
    }),
}));

export const useOAuthConnectAttemptStore = createSelectors(
  useOAuthConnectAttemptStoreBase,
);
