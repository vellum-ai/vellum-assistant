/**
 * Zustand store for the active assistant's identity (name, version).
 *
 * `ChatLayout` writes via `useAssistantIdentityInit` (first load and
 * assistant-context changes) and reads name/version for the sidebar
 * header and `PreferencesMenu`. `ChatPage` also writes from its own
 * local state when the daemon pushes a fresher identity (SSE
 * `identity_changed`) — idempotent with the layout write.
 *
 * A Zustand store avoids prop drilling through the React Router
 * outlet context for simple scalar values.
 *
 * @see {@link https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components}
 */
import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface AssistantIdentityState {
  name: string | null;
  version: string | null;
}

interface AssistantIdentityActions {
  setIdentity: (name: string | null, version: string | null) => void;
  clearIdentity: () => void;
}

type AssistantIdentityStore = AssistantIdentityState & AssistantIdentityActions;

const useAssistantIdentityStoreBase = create<AssistantIdentityStore>(
  (set) => ({
    name: null,
    version: null,
    setIdentity: (name, version) => set({ name, version }),
    clearIdentity: () => set({ name: null, version: null }),
  }),
);

export const useAssistantIdentityStore = createSelectors(
  useAssistantIdentityStoreBase,
);
