import { lazy } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";

const AddCreditsModal = lazy(() =>
  import("@/components/add-credits-modal").then((m) => ({
    default: m.AddCreditsModal,
  })),
);

/**
 * Lazily mounted Add Credits modal for chat-surface CTAs, driven by
 * {@link useAddCreditsModalStore}. Mounted once in `ActiveChatView` so the
 * checkout outlives the conditionally-rendered CTAs that open it; the store
 * subscription lives here so toggling the modal re-renders only this
 * component. The Stripe checkout modal stays out of the chat bundle: nothing
 * renders (and no chunk is fetched) until a CTA first opens it.
 */
export function LazyAddCreditsModal() {
  const open = useAddCreditsModalStore.use.open();
  const setOpen = useAddCreditsModalStore.use.setOpen();
  if (!open) {
    return null;
  }
  return (
    <LazyBoundary>
      <AddCreditsModal open={open} onOpenChange={setOpen} />
    </LazyBoundary>
  );
}
