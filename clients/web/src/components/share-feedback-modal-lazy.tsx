import { type ComponentType, lazy, useState } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import type { ShareFeedbackModalProps } from "@/components/share-feedback-modal";
import { ShareFeedbackModalFallback } from "@/components/share-feedback-modal-fallback";
import { ShareFeedbackModalLoadError } from "@/components/share-feedback-modal-load-error";

export type ShareFeedbackModalLoader = () => Promise<{
  default: ComponentType<ShareFeedbackModalProps>;
}>;

const loadShareFeedbackModal: ShareFeedbackModalLoader = () =>
  import("@/components/share-feedback-modal").then((m) => ({
    default: m.ShareFeedbackModal,
  }));

/**
 * Warm the dialog's chunk ahead of the click that needs it.
 *
 * Best-effort: a rejection here must not surface as an unhandled rejection,
 * and the open path still reports a real failure through the boundary below.
 */
export function prefetchShareFeedbackModal(): void {
  void loadShareFeedbackModal().catch(() => {});
}

export interface ShareFeedbackModalLazyProps extends ShareFeedbackModalProps {
  /** Overridden in tests to drive the failure and retry paths. */
  loader?: ShareFeedbackModalLoader;
}

/**
 * The one place the Share Feedback dialog's lazy wiring lives: the visible
 * loading placeholder, the visible load failure, and the retry that makes the
 * failure recoverable without a full page reload.
 *
 * `React.lazy` caches the rejected import promise on the component it created,
 * so retrying means holding the lazy component in state and minting a fresh
 * one from the click. `attempt` remounts the boundary alongside it, which is
 * what clears the error it is still showing.
 */
export function ShareFeedbackModalLazy({
  loader = loadShareFeedbackModal,
  ...props
}: ShareFeedbackModalLazyProps) {
  const [Modal, setModal] = useState(() => lazy(loader));
  const [attempt, setAttempt] = useState(0);

  const retry = () => {
    setModal(() => lazy(loader));
    setAttempt((n) => n + 1);
  };

  return (
    <LazyBoundary
      key={attempt}
      fallback={<ShareFeedbackModalFallback onClose={props.onClose} />}
      errorFallback={
        <ShareFeedbackModalLoadError onRetry={retry} onClose={props.onClose} />
      }
    >
      <Modal {...props} />
    </LazyBoundary>
  );
}
