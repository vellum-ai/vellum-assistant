import { Paperclip } from "lucide-react";

import { cn } from "@vellumai/design-library";

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
  now: Date;
  onSelect: (id: string) => void;
}

/**
 * One message in the list: a rounded row inside the card, the way the
 * sidebar draws its conversations, with hover and selection as washes
 * rather than rules between rows. Inbound rows lead with who wrote;
 * outbound rows lead with who it went to, since the sender is always the
 * assistant. The third line is the preview, drawn only when the row has
 * one: the platform's list carries none, so its rows are two lines. No
 * read state: the platform keeps none, so the list does not pretend to.
 */
function EmailListRow({ email, selected, now, onSelect }: EmailListRowProps) {
  const { t, i18n } = useTranslation("assistant-inbox");
  const counterpart =
    email.direction === "inbound" ? email.from : (email.to[0] ?? email.from);
  const who =
    email.direction === "inbound"
      ? displayName(counterpart)
      : t("emailListRow.toPrefix", { name: displayName(counterpart) });
  const attachmentCount = email.attachments?.length ?? 0;
  const hasThirdLine = email.snippet != null || attachmentCount > 0;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(email.id)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-150",
          "[@media(hover:hover)]:hover:bg-[var(--surface-hover)]",
          "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
          selected &&
            "bg-[var(--surface-active)] [@media(hover:hover)]:hover:bg-[var(--surface-active)]",
        )}
      >
        <SenderDisc participant={counterpart} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
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
          <span className="truncate text-body-small-lighter text-[var(--content-default)]">
            {email.subject || t("emailListRow.noSubject")}
          </span>
          {hasThirdLine ? (
            <span className="flex items-center gap-1.5 text-body-small-lighter text-[var(--content-tertiary)]">
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
        </span>
      </button>
    </li>
  );
}

export interface EmailListProps {
  emails: InboxEmail[];
  selectedId: string | null;
  now: Date;
  onSelect: (id: string) => void;
  className?: string;
}

/** The scrolling message list for one folder. */
export function EmailList({
  emails,
  selectedId,
  now,
  onSelect,
  className,
}: EmailListProps) {
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
          now={now}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
