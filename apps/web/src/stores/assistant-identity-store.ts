/**
 * Zustand store for the active assistant's identity (name, version).
 *
 * `ChatPage` writes to this store when it fetches the assistant identity
 * from the daemon. `ChatLayout` reads from it to display the assistant
 * name in the sidebar header and pass the version to `PreferencesMenu`.
 *
 * This store bridges the layout↔page boundary: `ChatLayout` owns the
 * sidebar and header chrome but the identity fetch lives in `ChatPage`
 * (which owns the full chat lifecycle). A Zustand store avoids prop
 * drilling through the React Router outlet context for simple scalar
 * values.
 *
 * @see {@link https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components}
 */
import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";

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
