import { type FormEvent, useEffect, useRef, useState } from "react";

import { Ban } from "lucide-react";

import { Button, Input, Modal } from "@vellumai/design-library";

import { IconTile } from "@/domains/chat/components/icon-tile";
import {
  getGroupIcon,
  GROUP_ICON_NAMES,
} from "@/domains/chat/utils/group-icon-registry";

/**
 * In-app dialog for entering or editing a name — used to rename a conversation,
 * create a group ("New group"), and rename a group. Replaces the browser's
 * native `window.prompt`, which renders as an OS-themed "www.vellum.ai says"
 * alert that doesn't match the app's chrome, has no consistent keyboard / focus
 * behavior on macOS Safari + iOS, and is disabled entirely in the Electron
 * desktop client.
 *
 * Fully controlled: the caller owns `open`, `initialValue`, and the labels, and
 * routes submit / cancel back. State is intentionally local (there's no
 * server-side draft to mirror), which keeps the component trivially testable.
 *
 * Group dialogs may additionally opt into an icon picker via `iconPicker`;
 * the chosen icon name rides along as `onSubmit`'s second argument.
 */
interface NameInputDialogProps {
  open: boolean;
  /** Dialog heading, e.g. "Rename conversation", "New group", "Rename group". */
  title: string;
  /** Confirm-button label, e.g. "Save" or "Create". */
  submitLabel: string;
  /**
   * Initial input value — empty when creating, the current name when renaming
   * (pre-selected so typing replaces it in one motion, matching the native
   * prompt's behavior).
   */
  initialValue: string;
  /**
   * When set, renders a group-icon picker below the name field, seeded with
   * `initialIcon` (null = no icon). Omit for plain name dialogs.
   */
  iconPicker?: { initialIcon: string | null };
  /**
   * Invoked with the trimmed value on confirm. The dialog filters out empty
   * values and no-op edits, so consumers can assume `value` is non-empty and
   * that the name or (when `iconPicker` is enabled) the icon changed.
   * `icon` is the picked icon name, `null` for "no icon", and `undefined`
   * when the dialog has no picker.
   */
  onSubmit: (value: string, icon?: string | null) => void;
  onCancel: () => void;
}

/**
 * Grid of selectable group icons plus a leading "no icon" tile, built from
 * the shared {@link IconTile} (the collapsed sidebar rail uses the same
 * tile), so a group's picker tile and its rail tile render identically.
 */
function GroupIconPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (icon: string | null) => void;
}) {
  return (
    <fieldset className="mt-3 border-0 p-0">
      <legend className="mb-1.5 text-sm text-[var(--content-secondary)]">
        Icon
      </legend>
      <div className="flex flex-wrap gap-1">
        <IconTile
          label="No icon"
          aria-pressed={value === null}
          onClick={() => onChange(null)}
        >
          <Ban size={14} />
        </IconTile>
        {GROUP_ICON_NAMES.map((name) => {
          const Icon = getGroupIcon(name);
          if (!Icon) {
            return null;
          }
          return (
            <IconTile
              key={name}
              label={name}
              aria-pressed={value === name}
              onClick={() => onChange(name)}
            >
              <Icon size={14} />
            </IconTile>
          );
        })}
      </div>
    </fieldset>
  );
}

export function NameInputDialog({
  open,
  title,
  submitLabel,
  initialValue,
  iconPicker,
  onSubmit,
  onCancel,
}: NameInputDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const initialIcon = iconPicker?.initialIcon ?? null;
  const [icon, setIcon] = useState<string | null>(initialIcon);

  // Reset the fields each time a request opens so the inputs start from the
  // live initial values, even if the dialog remounts against a different
  // target in the same session.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setIcon(initialIcon);
    }
  }, [open, initialValue, initialIcon]);

  const trimmed = value.trim();
  const iconChanged = iconPicker != null && icon !== initialIcon;
  const submitDisabled =
    trimmed.length === 0 || (trimmed === initialValue.trim() && !iconChanged);

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled) {
      return;
    }
    if (iconPicker) {
      onSubmit(trimmed, icon);
    } else {
      onSubmit(trimmed);
    }
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        // The title + input pair is self-evident; opt out of Radix's
        // `aria-describedby` requirement rather than adding a throwaway
        // description sentence.
        aria-describedby={undefined}
        // Radix would otherwise leave the cursor at the start of the
        // pre-filled value — select-all so typing replaces it in one motion,
        // the same UX as `window.prompt`.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = inputRef.current;
          if (input) {
            input.focus();
            // iOS Safari/WKWebView ignores selection APIs called
            // synchronously during focus — defer to the next frame.
            requestAnimationFrame(() => {
              input.setSelectionRange(0, input.value.length);
            });
          }
        }}
        // When stacked inside another modal, Escape should close only this
        // dialog: preventDefault stops Radix's own close path (avoiding a
        // double-close via onOpenChange) and stopPropagation keeps parent
        // keydown listeners from also seeing it.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
      >
        <form onSubmit={handleFormSubmit}>
          <Modal.Header>
            <Modal.Title>{title}</Modal.Title>
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
            {iconPicker ? (
              <GroupIconPicker value={icon} onChange={setIcon} />
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" variant="outlined" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitDisabled}>
              {submitLabel}
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
