import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Zustand store for the chat Add Credits checkout modal's open state. Chat
 * CTAs (the low-balance composer banner, the credits upsell card) only write
 * `open`; the modal is mounted once at a stable ancestor (`ActiveChatView`)
 * that outlives the CTAs, so an in-progress checkout survives its trigger
 * unmounting when live billing state changes mid-interaction. In-memory only:
 * a reload never resumes an open checkout.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */
interface AddCreditsModalState {
  /** True while the checkout modal is open. */
  open: boolean;
}

interface AddCreditsModalActions {
  setOpen: (open: boolean) => void;
}

const useAddCreditsModalStoreBase = create<
  AddCreditsModalState & AddCreditsModalActions
>()((set) => ({
  open: false,

  setOpen: (open) => set({ open }),
}));

export const useAddCreditsModalStore = createSelectors(
  useAddCreditsModalStoreBase,
);
