/**
 * The listening-language picker: the short static catalog as a selectable
 * list in a small modal, hosted outside the settings popover (a sibling of
 * {@link VoicePickerModal}) so closing the popover can't unmount it and no
 * transformed ancestor interferes with its positioning. A pick hot-applies
 * from the next spoken turn (there is nothing to save), so it also closes
 * the picker.
 *
 * The options are real buttons carrying the listbox pattern (`role="option"`
 * inside `role="listbox"`), so Tab reaches the list and Enter/Space select
 * natively; ArrowUp/ArrowDown/Home/End move focus between options via the
 * container's keydown handler.
 */

import { type KeyboardEvent, useRef } from "react";

import { Check } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Modal } from "@vellumai/design-library/components/modal";

import { useSttLanguageSelection } from "@/components/speech/use-stt-language-selection";
import {
  sttLanguageLabel,
  sttLanguageOptionsFor,
} from "@/lib/stt/language-catalog";

export interface ListeningLanguagePickerModalProps {
  assistantId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ListeningLanguagePickerModal({
  assistantId,
  open,
  onOpenChange,
}: ListeningLanguagePickerModalProps) {
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="sm">
        {/* Own component so its daemon queries run only while the modal is
            open — the host keeps this mounted across a whole session. */}
        <ListeningLanguagePickerContent
          assistantId={assistantId}
          onDone={() => onOpenChange(false)}
        />
      </Modal.Content>
    </Modal.Root>
  );
}

function ListeningLanguagePickerContent({
  assistantId,
  onDone,
}: {
  assistantId: string | null;
  onDone: () => void;
}) {
  const { currentCode, configuredProviderId, selectLanguage, selecting } =
    useSttLanguageSelection(assistantId);

  const listRef = useRef<HTMLDivElement>(null);

  // Roving focus between the option buttons. Enter/Space need no handling:
  // the options are buttons, so activation comes for free.
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
    if (options.length === 0) {
      return;
    }
    // Keep the arrows from scrolling the list body underneath the focus move.
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : event.key === "ArrowDown"
            ? Math.min(index + 1, options.length - 1)
            : Math.max(index - 1, 0);
    options[next]?.focus();
  };

  return (
    <>
      <Modal.Header>
        <Modal.Title>Listening language</Modal.Title>
        <Modal.Description>
          Applies from your next spoken turn.
        </Modal.Description>
      </Modal.Header>
      <Modal.Body>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Listening language"
          onKeyDown={moveFocus}
          className={cn(
            "flex max-h-[60vh] flex-col overflow-y-auto",
            selecting && "pointer-events-none opacity-70",
          )}
        >
          {sttLanguageOptionsFor(currentCode, configuredProviderId).map(
            (option) => {
              const isSelected = option.code === currentCode;
              return (
                <button
                  key={option.code}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    // Mirrors the pointer-events guard above for the keyboard
                    // path: no picks land while a write is in flight.
                    if (selecting) {
                      return;
                    }
                    selectLanguage(option.code);
                    onDone();
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left transition-colors",
                    // Selected reads as a soft persistent fill + a trailing
                    // check, like the voice list — not a form-field border.
                    isSelected
                      ? "bg-[var(--surface-active)]"
                      : "hover:bg-[var(--surface-hover)]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
                    {sttLanguageLabel(option)}
                    {option.description && (
                      <span className="block truncate text-label-small-default text-[var(--content-tertiary)]">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {isSelected && (
                    <Check
                      aria-hidden
                      className="size-4 shrink-0 text-[var(--system-positive-strong)]"
                    />
                  )}
                </button>
              );
            },
          )}
        </div>
      </Modal.Body>
    </>
  );
}
