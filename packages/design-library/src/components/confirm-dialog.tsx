import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./button";
import { Modal } from "./modal";
import { Notice } from "./notice";

/**
 * Pre-composed confirmation dialog built on `Modal`.
 *
 * Renders a small modal with a title, message, and Cancel / Confirm
 * buttons. Supports a `destructive` variant that styles the confirm
 * button as danger and shows a warning icon.
 *
 * The `error` slot lets a caller keep the dialog open after a failed
 * confirm, so the user reads why it failed next to the button they can
 * press again.
 *
 * Focus is auto-directed to the confirm button on open so pressing
 * Enter confirms without requiring Tab. Escape closes only this dialog,
 * not any parent modal it may be stacked inside.
 */

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  /** Inline failure message shown under the message while the dialog stays open. */
  error?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const CONFIRM_BUTTON_ATTR = "data-confirm-dialog-confirm";

function ConfirmDialog({
  open,
  title,
  message,
  error,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  isPending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !isPending) {
          onCancel();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        onOpenAutoFocus={(event) => {
          const content = event.currentTarget as HTMLElement | null;
          const confirmButton = content?.querySelector<HTMLButtonElement>(
            `[${CONFIRM_BUTTON_ATTR}]`,
          );
          if (confirmButton) {
            event.preventDefault();
            confirmButton.focus();
          }
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!isPending) onCancel();
        }}
      >
        <Modal.Header icon={destructive ? AlertTriangle : undefined}>
          <Modal.Title>{title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Modal.Description>{message}</Modal.Description>
          {error != null ? (
            <div className="mt-3">
              <Notice tone="error">{error}</Notice>
            </div>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onCancel} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={isPending}
            leftIcon={isPending ? <Loader2 className="animate-spin" /> : undefined}
            {...{ [CONFIRM_BUTTON_ATTR]: "" }}
          >
            {confirmLabel}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

export { ConfirmDialog };
export type { ConfirmDialogProps };
