/**
 * Zustand store for the active assistant's identity (name, version).
 *
 * `RootLayout` writes via `useAssistantIdentityInit` (first load and
 * assistant-context changes); `ChatLayout` reads name/version for the
 * sidebar header and `PreferencesMenu`. `ChatPage` also writes from its
 * own local state when the assistant pushes a fresher identity (SSE
 * `identity_changed`), idempotent with the layout write.
 *
 * A Zustand store avoids prop drilling through the React Router
 * outlet context for simple scalar values.
 *
 * Dev-only version impersonation: `setIdentity` consults
 * `getImpersonatedAssistantVersion()` and substitutes its value when
 * set. This funnels every real write site (initial identity fetch,
 * SSE identity_changed, the optimistic onboarding seed) through the
 * same override path so version-gated code (`useAssistantSupports`,
 * `pickConversationIdWireField`, `supportsServerMintedConversation`,
 * …) sees a uniform impersonated value without any consumer needing
 * to know the flag exists. See `lib/backwards-compat/impersonate-version-flag.ts`.
 *
 * @see {@link https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components}
 */
import { create } from "zustand";

import { getImpersonatedAssistantVersion } from "@/lib/backwards-compat/impersonate-version-flag";
import { createSelectors } from "@/utils/create-selectors";

interface AssistantIdentityState {
  name: string | null;
  version: string | null;
  /**
   * The assistant this identity was fetched for. Written in the same
   * `set()` as `version`, so "whose version is this" is answerable from
   * a single atomic store read. Gates that must scope a version check
   * to a specific assistant (rather than "whatever identity is
   * currently hydrated") compare against this instead of pairing the
   * version with `activeAssistantId` from the resolved-assistants
   * store, since the two stores update at different times on assistant
   * switch, so a cross-store pairing can read a stale version for one
   * render until the clear effect runs.
   */
  assistantId: string | null;
  /**
   * The assistant whose identity fetch has settled without producing an
   * identity: the request errored, or `fetchAssistantIdentity` swallowed an
   * unreachable runtime into a `null`.
   *
   * `version` alone cannot tell "still in flight" from "asked and got
   * nothing"; both read as `null`. A surface that only hides is right to wait
   * out either, but a surface that navigates on the answer would wait forever
   * on the second. This is the terminal bit that ends that wait. `null` while
   * the fetch is in flight or has produced an identity.
   */
  unavailableFor: string | null;
}

interface AssistantIdentityActions {
  setIdentity: (
    name: string | null,
    version: string | null,
    assistantId?: string | null,
  ) => void;
  /** Records that the identity fetch for `assistantId` reached a dead end. */
  markIdentityUnavailable: (assistantId: string | null) => void;
  clearIdentity: () => void;
}

type AssistantIdentityStore = AssistantIdentityState & AssistantIdentityActions;

const useAssistantIdentityStoreBase = create<AssistantIdentityStore>((set) => ({
  name: null,
  version: null,
  assistantId: null,
  unavailableFor: null,
  setIdentity: (name, version, assistantId = null) => {
    const impersonated = getImpersonatedAssistantVersion();
    // An identity in hand supersedes any earlier dead end for it: a refetch
    // that succeeds has to lift the terminal bit, or the surfaces that acted
    // on it would stay wrong for the rest of the session.
    set({
      name,
      version: impersonated ?? version,
      assistantId,
      unavailableFor: null,
    });
  },
  markIdentityUnavailable: (assistantId) =>
    set({ unavailableFor: assistantId }),
  clearIdentity: () =>
    set({ name: null, version: null, assistantId: null, unavailableFor: null }),
}));

export const useAssistantIdentityStore = createSelectors(
  useAssistantIdentityStoreBase,
);
