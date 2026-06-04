import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button, Input, Modal } from "@vellumai/design-library";

/**
 * In-app rename modal for a single conversation. Replaces the browser's
 * native `window.prompt`, which renders as an OS-themed "www.vellum.ai
 * says" alert that doesn't match the app's chrome and has no consistent
 * keyboard / focus behavior on macOS Safari + iOS.
 *
 * The dialog is fully controlled: callers own `open` and the rename
 * target's `currentTitle`, and submit / cancel are routed back through
 * `onSubmit` / `onCancel`. State is intentionally local — there's no
 * server-side draft to mirror, and the controlled API keeps the
 * component trivially testable.
 */
interface RenameConversationDialogProps {
  open: boolean;
  /**
   * The conversation's current title at the moment the dialog opens.
   * Pre-populated into the input and selected so typing replaces it in
   * one motion (matching the native prompt's behavior).
   */
  currentTitle: string;
  /**
   * Invoked with the trimmed new title when the user confirms. The dialog
   * itself filters out empty strings and no-op renames; consumers can
   * assume `newTitle` is non-empty and meaningfully different from the
   * current title.
   */
  onSubmit: (newTitle: string) => void;
  onCancel: () => void;
}

function RenameConversationDialog({
  open,
  currentTitle,
  onSubmit,
  onCancel,
}: RenameConversationDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(currentTitle);

  // Reset the field each time a new rename request opens so the input
  // always starts from the live current title — even if the dialog
  // remounts against a different conversation in the same session.
  useEffect(() => {
    if (open) {
      setValue(currentTitle);
    }
  }, [open, currentTitle]);

  const trimmed = value.trim();
  const submitDisabled = trimmed.length === 0 || trimmed === currentTitle.trim();

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled) return;
    onSubmit(trimmed);
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        // The title + input pair is self-evident; opt out of Radix's
        // `aria-describedby` requirement explicitly rather than adding a
        // throwaway description sentence.
        aria-describedby={undefined}
        // Radix would otherwise leave the cursor at the start of the
        // pre-filled title — select-all so typing replaces it in one
        // motion, the same UX as `window.prompt`.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = inputRef.current;
          if (input) {
            input.focus();
            // iOS Safari/WKWebView ignores selection APIs called
            // synchronously during focus — the editing context isn't
            // ready until the next frame.
            requestAnimationFrame(() => {
              input.setSelectionRange(0, input.value.length);
            });
          }
        }}
        // When stacked inside another modal, Escape should close only
        // this dialog. preventDefault stops Radix's own close path so
        // we don't double-close via onOpenChange(false); stopPropagation
        // keeps parent keydown listeners from also seeing the event.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
      >
        <form onSubmit={handleFormSubmit}>
          <Modal.Header>
            <Modal.Title>Rename conversation</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Input
              ref={inputRef}
              label="Name"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              fullWidth
            />
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" variant="outlined" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitDisabled}>
              Save
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}

export { RenameConversationDialog };
export type { RenameConversationDialogProps };
