/**
 * Modal shown when a chat message fails to POST in a context where rolling
 * back optimistic state to "blank slate" is the right move (e.g. the user
 * was on the new-conversation page and the daemon's secret-ingress check
 * rejected the message). Dismissing the modal restores the original text
 * back into the composer so the user can edit and resend.
 *
 * Inline POST failures (mid-conversation) keep using the standard inline
 * Notice. This modal is only mounted when `error.displayAs === "modal"`.
 */

import { Button, Modal } from "@vellumai/design-library";

interface SendErrorModalProps {
  open: boolean;
  title?: string;
  message: string;
  /** Called when the user dismisses (Escape, overlay click, or button). */
  onClose: () => void;
  /** Label for the dismiss button. Defaults to "Got it". */
  dismissLabel?: string;
}

export function SendErrorModal({
  open,
  title = "Message blocked",
  message,
  onClose,
  dismissLabel = "Got it",
}: SendErrorModalProps) {
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>{title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p
            className="!m-0 text-body-medium-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {message}
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={onClose}>
            {dismissLabel}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
