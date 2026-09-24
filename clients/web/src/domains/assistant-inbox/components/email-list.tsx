import { Paperclip } from "lucide-react";

import { Checkbox, cn, CrossfadeStack } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import { formatEmailListTime } from "../format-email-time";
import type { EmailParticipant, InboxEmail } from "../types";
import { SenderDisc } from "./sender-disc";

function displayName(participant: EmailParticipant): string {
  return participant.name?.trim() || participant.address;
}

interface EmailListRowProps {
  email: InboxEmail;
  selected: boolean;
  checked: boolean;
  /** Some row in the list is checked, so every row shows its checkbox. */
  selecting: boolean;
  now: Date;
  onSelect: (id: string) => void;
  onToggleChecked?: (id: string) => void;
}

/**
 * One message in the list: a rounded row inside the card, the way the
 * sidebar draws its conversations, with hover and selection as washes
 * rather than rules between rows. Inbound rows lead with who wrote;
 * outbound rows lead with who it went to, since the sender is always the
 * assistant. The third line is the preview, drawn only when the row has
 * one: the platform's list carries none, so its rows are two lines. No
 * read state: the platform keeps none, so the list does not pretend to.
 *
 * The sender's disc shares its cell with the row's checkbox. Under a mouse
 * the box takes the disc's place on hover and holds it once this row or any
 * row is checked, so a selection in progress reads as one; where nothing
 * hovers the two sit side by side, since a control only hover reveals is
 * unreachable there. The checkbox is a button of its own and cannot nest in
 * the row's, so the row is a list item with the disc cell beside the button
 * that opens the message.
 */
function EmailListRow({
  email,
  selected,
  checked,
  selecting,
  now,
  onSelect,
  onToggleChecked,
}: EmailListRowProps) {
  const { t, i18n } = useTranslation("assistant-inbox");
  const counterpart =
    email.direction === "inbound" ? email.from : (email.to[0] ?? email.from);
  const who =
    email.direction === "inbound"
      ? displayName(counterpart)
      : t("emailListRow.toPrefix", { name: displayName(counterpart) });
  const attachmentCount = email.attachments?.length ?? 0;
  const hasThirdLine = email.snippet != null || attachmentCount > 0;
  const subject = email.subject || t("emailListRow.noSubject");
  const selectable = onToggleChecked !== undefined;

  return (
    <li
      data-reveal-row={selectable ? "" : undefined}
      data-reveal-hold={selectable && (checked || selecting) ? "" : undefined}
      data-checked={checked ? "" : undefined}
      className={cn(
        "flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150",
        "[@media(hover:hover)]:hover:bg-[var(--surface-hover)]",
        selected &&
          "bg-[var(--surface-active)] [@media(hover:hover)]:hover:bg-[var(--surface-active)]",
        checked && !selected && "bg-[var(--surface-hover)]",
      )}
    >
      {selectable ? (
        <CrossfadeStack className="mt-0.5 min-h-9 min-w-9">
          <span data-reveal-yield="">
            <SenderDisc participant={counterpart} />
          </span>
          <span data-reveal="" className="flex items-center justify-center">
            <Checkbox
              checked={checked}
              onCheckedChange={() => onToggleChecked(email.id)}
              aria-label={t("emailListRow.selectAria", { subject })}
              className="size-[18px] rounded-[5px]"
            />
          </span>
        </CrossfadeStack>
      ) : (
        <SenderDisc participant={counterpart} className="mt-0.5" />
      )}
      <button
        type="button"
        onClick={() => onSelect(email.id)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "-m-1 flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg p-1 text-left",
          "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        )}
      >
        <span className="flex w-full items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
            {who}
          </span>
          <time
            dateTime={email.createdAt}
            className="shrink-0 text-body-small-lighter text-[var(--content-tertiary)]"
          >
            {formatEmailListTime(email.createdAt, now, i18n.language)}
          </time>
        </span>
        <span className="w-full truncate text-body-small-lighter text-[var(--content-default)]">
          {subject}
        </span>
        {hasThirdLine ? (
          <span className="flex w-full items-center gap-1.5 text-body-small-lighter text-[var(--content-tertiary)]">
            {attachmentCount > 0 ? (
              <Paperclip
                className="size-3 shrink-0"
                aria-label={t("emailListRow.attachments", {
                  count: attachmentCount,
                })}
              />
            ) : null}
            {email.snippet != null ? (
              <span className="truncate">{email.snippet}</span>
            ) : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export interface EmailListProps {
  emails: InboxEmail[];
  selectedId: string | null;
  now: Date;
  onSelect: (id: string) => void;
  /** Ids the user has checked. The list offers checkboxes only with `onToggleChecked`. */
  checkedIds?: ReadonlySet<string>;
  onToggleChecked?: (id: string) => void;
  className?: string;
}

/** The scrolling message list for one folder. */
export function EmailList({
  emails,
  selectedId,
  now,
  onSelect,
  checkedIds,
  onToggleChecked,
  className,
}: EmailListProps) {
  const selecting =
    checkedIds !== undefined &&
    emails.some((email) => checkedIds.has(email.id));
  return (
    <ul
      className={cn(
        "flex min-h-0 flex-col gap-0.5 overflow-y-auto p-2",
        className,
      )}
    >
      {emails.map((email) => (
        <EmailListRow
          key={email.id}
          email={email}
          selected={email.id === selectedId}
          checked={checkedIds?.has(email.id) ?? false}
          selecting={selecting}
          now={now}
          onSelect={onSelect}
          onToggleChecked={onToggleChecked}
        />
      ))}
    </ul>
  );
}
