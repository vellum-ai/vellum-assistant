import { lazy } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";

const AddCreditsModal = lazy(() =>
  import("@/components/add-credits-modal").then((m) => ({
    default: m.AddCreditsModal,
  })),
);

interface LazyAddCreditsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Lazily mounted Add Credits modal for chat-surface CTAs. The Stripe checkout
 * modal stays out of the chat bundle: nothing renders (and no chunk is
 * fetched) until a CTA first opens it.
 */
export function LazyAddCreditsModal({
  open,
  onOpenChange,
}: LazyAddCreditsModalProps) {
  if (!open) {
    return null;
  }
  return (
    <LazyBoundary>
      <AddCreditsModal open={open} onOpenChange={onOpenChange} />
    </LazyBoundary>
  );
}
