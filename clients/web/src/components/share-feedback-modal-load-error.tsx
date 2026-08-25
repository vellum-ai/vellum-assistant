import { useRef } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { useTranslation } from "@/i18n";

export interface ShareFeedbackModalLoadErrorProps {
  onRetry: () => void;
  onClose: () => void;
}

/**
 * Shown in place of the Share Feedback dialog when its chunk never arrives.
 *
 * Built on the design library's modal, which is what supplies the focus trap,
 * escape-to-dismiss, and dialog semantics. A bare portalled backdrop supplies
 * none of them: it conceals the page visually while leaving every control
 * behind it in the tab order.
 *
 * The message is the modal's title rather than body copy, which is both what a
 * screen reader announces on open and the only element Radix needs to label
 * the dialog. `aria-describedby` is cleared because nothing further describes
 * it.
 */
export function ShareFeedbackModalLoadError({
  onRetry,
  onClose,
}: ShareFeedbackModalLoadErrorProps) {
  const { t } = useTranslation();
  const retryRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          // Recovery is the reason this dialog exists, so open on it rather
          // than on the dismiss that Radix would reach first in DOM order.
          event.preventDefault();
          retryRef.current?.focus();
        }}
      >
        <Modal.Header className="pr-4">
          {/* A sentence, not a label: let it wrap instead of truncating. */}
          <Modal.Title className="[&>span]:whitespace-normal">
            {t("shareFeedbackModalLoadError.message")}
          </Modal.Title>
        </Modal.Header>
        <Modal.Footer>
          <Button variant="ghost" onClick={onClose}>
            {t("shareFeedbackModalLoadError.close")}
          </Button>
          <Button ref={retryRef} variant="primary" onClick={onRetry}>
            {t("shareFeedbackModalLoadError.retry")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
