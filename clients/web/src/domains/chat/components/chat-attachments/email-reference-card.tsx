import { Mail, Send } from "lucide-react";
import { Link } from "react-router";

import { cn, Typography } from "@vellumai/design-library";

import { ATTACHMENT_TILE_BOX_CLASS } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import { useTranslation } from "@/i18n";
import type {
  EmailReference,
  EmailReferenceParticipant,
} from "@/types/email-reference";
import { routes } from "@/utils/routes";

function displayName(participant: EmailReferenceParticipant): string {
  return participant.name?.trim() || participant.address;
}

function shortDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
}

export interface EmailReferenceCardProps {
  email: EmailReference;
  className?: string;
}

/**
 * One email in a sent bubble, drawn the way the bubble draws a file: the
 * attachment tile's box with the mail's glyph in it, a caption beside it,
 * and the whole card a link back to the message in the Assistant Inbox.
 * The tile's wash and the caption's first word both say received or sent,
 * as the composer chip does, so the two read as the same thing before and
 * after the send.
 */
export function EmailReferenceCard({
  email,
  className,
}: EmailReferenceCardProps) {
  const { t, i18n } = useTranslation("chat");
  const inbound = email.direction === "inbound";
  const counterpart = inbound ? email.from : (email.to[0] ?? email.from);
  const subject = email.subject.trim() || t("emailReferenceChip.noSubject");
  const who = inbound
    ? t("emailReferenceChip.from", { name: displayName(counterpart) })
    : t("emailReferenceChip.to", { name: displayName(counterpart) });
  const direction = inbound
    ? t("emailReferenceChip.received")
    : t("emailReferenceChip.sent");
  const when = shortDate(email.createdAt, i18n.language);
  const Icon = inbound ? Mail : Send;
  const caption = [direction, who, when].filter(Boolean).join(" · ");

  return (
    <Link
      to={routes.assistantInboxMessage(email.id, inbound ? "received" : "sent")}
      data-testid="email-reference-card"
      data-direction={email.direction}
      aria-label={t("emailReferenceCard.openAria", { subject })}
      title={`${subject}\n${caption}`}
      className={cn(
        "group/email flex w-fit max-w-full items-center gap-3 rounded-lg outline-none",
        "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          ATTACHMENT_TILE_BOX_CLASS,
          "flex items-center justify-center border border-[var(--border-element)] transition-colors",
          inbound
            ? "bg-[var(--system-info-weak)]"
            : "bg-[var(--system-positive-weak)]",
          "group-hover/email:border-[var(--border-hover)]",
        )}
      >
        <Icon className="h-6 w-6 text-[var(--content-default)]" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <Typography
          variant="label-small-default"
          className="max-w-[240px] truncate text-[var(--content-default)] group-hover/email:underline"
        >
          {subject}
        </Typography>
        <Typography
          variant="label-small-default"
          className="max-w-[240px] truncate text-[var(--content-tertiary)]"
        >
          {caption}
        </Typography>
      </span>
    </Link>
  );
}
