/**
 * The body of the listening-language picker modal: the short static catalog
 * as a selectable list. Split from {@link ListeningLanguagePickerModal} so
 * the modal file stays a thin wrapper and this listbox owns the interaction
 * details.
 *
 * Selection state arrives as props from `useSttLanguageSelection`, which the
 * voice-room settings menu calls once at a mount point that outlives this
 * content (the modal unmounts it on close). Keeping the hook out of here
 * preserves its serialized write chain across close/reopen: a pick made
 * while an earlier slow PATCH is still in flight queues behind that write
 * instead of racing it, so no reopen-and-repick can land an older request
 * last. For the same reason a pick during an in-flight write is allowed, not
 * blocked; the list only dims (`aria-busy`) while a write is pending.
 *
 * The options are real buttons carrying the listbox pattern (`role="option"`
 * inside `role="listbox"`), so Enter/Space select natively;
 * ArrowUp/ArrowDown/Home/End move focus between options via the container's
 * keydown handler. Tabindex roves anchored on the selection: the selected
 * option is the list's one tab stop and receives focus when the list mounts
 * (the modal wrapper redirects Radix's open autofocus to it), so a keyboard
 * user starts on their current language rather than on the first option,
 * where Enter would overwrite the setting.
 */

import { type KeyboardEvent, useRef } from "react";

import { Check } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Modal } from "@vellumai/design-library/components/modal";

import {
  sttLanguageLabel,
  sttLanguageOptionsFor,
} from "@/lib/stt/language-catalog";

export interface ListeningLanguagePickerContentProps {
  /** The currently-selected catalog code, a pending pick included. */
  currentCode: string;
  /** Daemon id of the configured STT provider, scoping the option catalog. */
  configuredProviderId: string;
  /** Persist a pick; the owning hook serializes writes in call order. */
  selectLanguage: (code: string) => void;
  /** A write is in flight; the list dims but stays interactive. */
  selecting: boolean;
  /** Close the picker (a pick hot-applies, so it also closes). */
  onDone: () => void;
}

export function ListeningLanguagePickerContent({
  currentCode,
  configuredProviderId,
  selectLanguage,
  selecting,
  onDone,
}: ListeningLanguagePickerContentProps) {
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
          aria-busy={selecting}
          onKeyDown={moveFocus}
          className={cn(
            "flex max-h-[60vh] flex-col overflow-y-auto",
            // The dim signals the in-flight write without blocking a
            // follow-up pick, which the hook queues behind it.
            selecting && "opacity-70",
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
                  // Roving tabindex anchored on the selection: the selected
                  // option is the one tab stop into the list.
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => {
                    selectLanguage(option.code);
                    onDone();
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left transition-colors",
                    // Selected reads as a soft persistent fill + a trailing
                    // check, like the voice list, not a form-field border.
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
