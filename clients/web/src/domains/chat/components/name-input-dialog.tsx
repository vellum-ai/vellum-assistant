import { type FormEvent, useEffect, useRef, useState } from "react";

import { Ban } from "lucide-react";

import { Button, Input, Modal } from "@vellumai/design-library";

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
 * Grid of selectable group icons plus a leading "no icon" tile.
 *
 * These are form controls, not navigation, so they are design-library
 * {@link Button}s: `ghost` + `iconOnly` for the tile chrome, `active` for the
 * selected surface. The collapsed rail draws the same group icons from
 * `SideMenu.Item` instead, because there they are nav rows in the sidebar's
 * own 30px column. The two surfaces are deliberately not one component.
 *
 * `expandOnMobile={false}` keeps the grid a grid: icon-only buttons otherwise
 * grow to a 40px circular tap target on touch, which would turn a dense
 * picker into a sparse column of circles inside the dialog.
 */
function GroupIconPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (icon: string | null) => void;
}) {
  // The selected tile's `active` surface is `--surface-lift`, which is the
  // dialog's own background: the ring, not the fill, is what makes a
  // selection read without hover.
  const tileClassName =
    "aria-pressed:ring-1 aria-pressed:ring-[var(--border-active)]";

  return (
    <fieldset className="mt-3 border-0 p-0">
      <legend className="mb-1.5 text-sm text-[var(--content-secondary)]">
        Icon
      </legend>
      <div className="flex flex-wrap gap-1">
        <Button
          variant="ghost"
          iconOnly={<Ban />}
          expandOnMobile={false}
          active={value === null}
          aria-pressed={value === null}
          aria-label="No icon"
          tooltip="No icon"
          className={tileClassName}
          onClick={() => onChange(null)}
        />
        {GROUP_ICON_NAMES.map((name) => {
          const Icon = getGroupIcon(name);
          if (!Icon) {
            return null;
          }
          return (
            <Button
              key={name}
              variant="ghost"
              iconOnly={<Icon />}
              expandOnMobile={false}
              active={value === name}
              aria-pressed={value === name}
              aria-label={name}
              tooltip={name}
              className={tileClassName}
              onClick={() => onChange(name)}
            />
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
