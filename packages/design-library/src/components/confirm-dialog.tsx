import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./button";
import { Modal } from "./modal";

/**
 * Pre-composed confirmation dialog built on `Modal`.
 *
 * Renders a small modal with a title, message, and Cancel / Confirm
 * buttons. Supports a `destructive` variant that styles the confirm
 * button as danger and shows a warning icon.
 *
 * Focus is auto-directed to the confirm button on open so pressing
 * Enter confirms without requiring Tab. Escape closes only this dialog,
 * not any parent modal it may be stacked inside.
 */

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
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
        <Modal.Header>
          <Modal.Title icon={destructive ? AlertTriangle : undefined}>
            {title}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Modal.Description>{message}</Modal.Description>
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
