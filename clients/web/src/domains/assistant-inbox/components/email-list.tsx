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
  /** A received message not yet opened on this device. */
  unread: boolean;
  now: Date;
  onSelect: (id: string) => void;
  onToggleChecked?: (id: string) => void;
}

/**
 * One message in the list, as the design draws it: the correspondent's disc,
 * then three stacked lines, who, the subject, and when, with hover and
 * selection as washes rather than rules between rows. Inbound rows lead with
 * who wrote; outbound rows lead with who it went to, since the sender is
 * always the assistant. No preview line: the platform's list carries none.
 * A received row not yet opened here carries a dot on its trailing edge and
 * the emphasised name; the platform keeps no read state, so the mark is
 * this device's memory of what was opened (see `useReadEmails`).
 *
 * The disc shares its cell with the row's checkbox. Under a mouse the box
 * takes the disc's place on hover and holds it once this row or any row is
 * checked, so a selection in progress reads as one; where nothing hovers the
 * two sit side by side, since a control only hover reveals is unreachable
 * there. The checkbox is a button of its own and cannot nest in the row's,
 * so the row is a list item with the disc cell beside the button that opens
 * the message.
 */
function EmailListRow({
  email,
  selected,
  checked,
  selecting,
  unread,
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
  const subject = email.subject || t("emailListRow.noSubject");
  const selectable = onToggleChecked !== undefined;

  return (
    <li
      data-reveal-row={selectable ? "" : undefined}
      data-reveal-hold={selectable && (checked || selecting) ? "" : undefined}
      data-checked={checked ? "" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-lg p-2 transition-colors duration-150",
        "[@media(hover:hover)]:hover:bg-[var(--surface-hover)]",
        selected &&
          "bg-[var(--surface-active)] [@media(hover:hover)]:hover:bg-[var(--surface-active)]",
        checked && !selected && "bg-[var(--surface-hover)]",
      )}
    >
      {selectable ? (
        <CrossfadeStack className="min-w-9 self-stretch">
          <span data-reveal-yield="">
            <SenderDisc participant={counterpart} />
          </span>
          <span data-reveal="" className="flex items-center justify-center">
            <Checkbox
              checked={checked}
              onCheckedChange={() => onToggleChecked(email.id)}
              aria-label={t("emailListRow.selectAria", { subject })}
              className="flex"
            />
          </span>
        </CrossfadeStack>
      ) : (
        <SenderDisc participant={counterpart} />
      )}
      <button
        type="button"
        onClick={() => onSelect(email.id)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "-m-1 flex min-w-0 flex-1 flex-col gap-0.5 rounded-md p-1 text-left",
          "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        )}
      >
        <span
          className={cn(
            "w-full truncate text-body-medium-default",
            unread
              ? "text-[var(--content-emphasised)]"
              : "text-[var(--content-default)]",
          )}
        >
          {who}
        </span>
        <span className="w-full truncate text-label-medium-default text-[var(--content-secondary)]">
          {subject}
        </span>
        <span className="flex w-full items-center gap-1.5 text-label-medium-default text-[var(--content-tertiary)]">
          <time dateTime={email.createdAt}>
            {formatEmailListTime(email.createdAt, now, i18n.language)}
          </time>
          {attachmentCount > 0 ? (
            <Paperclip
              className="size-3 shrink-0"
              aria-label={t("emailListRow.attachments", {
                count: attachmentCount,
              })}
            />
          ) : null}
        </span>
      </button>
      {unread ? (
        <span
          role="img"
          aria-label={t("emailListRow.unread")}
          className="mr-1 size-1.5 shrink-0 rounded-full bg-[var(--system-mid-strong)]"
        />
      ) : null}
    </li>
  );
}

export interface EmailListProps {
  emails: InboxEmail[];
  selectedId: string | null;
  now: Date;
  onSelect: (id: string) => void;
  /** Ids of received messages already opened; absent means no unread marks. */
  readIds?: ReadonlySet<string>;
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
  readIds,
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
        "flex min-h-0 flex-col gap-1 overflow-y-auto px-2 pb-2 pt-1",
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
          unread={
            readIds !== undefined &&
            email.direction === "inbound" &&
            !readIds.has(email.id)
          }
          now={now}
          onSelect={onSelect}
          onToggleChecked={onToggleChecked}
        />
      ))}
    </ul>
  );
}
