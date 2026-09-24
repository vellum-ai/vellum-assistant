import { Mail, Send } from "lucide-react";
import { Link } from "react-router";

import { cn } from "@vellumai/design-library";

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
 * One email in a sent bubble, at the composer's attachment chip scale: the
 * chip's 40px thumb box with the mail's glyph in it, the subject and a
 * caption beside it, and the whole card a link back to the message in the
 * Assistant Inbox.
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
        "group/email flex w-fit max-w-full items-center gap-3 rounded-lg bg-[var(--surface-base)] py-1 pl-1 pr-3 outline-none transition-colors",
        "[@media(hover:hover)]:hover:bg-[var(--surface-hover)]",
        "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
          inbound
            ? "bg-[var(--system-info-weak)]"
            : "bg-[var(--system-positive-weak)]",
        )}
      >
        <Icon className="h-4 w-4 text-[var(--content-default)]" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="max-w-[260px] truncate text-body-small-default leading-4 text-[var(--content-default)]">
          {subject}
        </span>
        <span className="max-w-[260px] truncate text-label-small-default leading-3 text-[var(--content-tertiary)]">
          {caption}
        </span>
      </span>
    </Link>
  );
}
