import { Mail, Send, X } from "lucide-react";
import type { MouseEventHandler } from "react";

import { Button, cn } from "@vellumai/design-library";

import type { EmailReferenceAttachment } from "@/domains/chat/composer-store";
import { useTranslation } from "@/i18n";
import type { EmailReferenceParticipant } from "@/types/email-reference";

function displayName(participant: EmailReferenceParticipant): string {
  return participant.name?.trim() || participant.address;
}

function shortDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  ).format(date);
}

export interface EmailReferenceChipProps {
  attachment: EmailReferenceAttachment;
  onRemove: (localId: string) => void;
  /** The composer's press guard, worn by the remove control. */
  pressGuard?: MouseEventHandler<HTMLElement>;
  className?: string;
}

/**
 * One inbox email staged in the composer strip. Shaped like the path
 * reference chip beside it (a leading glyph, two stacked lines, a remove
 * control), with the direction made plain twice over: the glyph and its wash
 * say received or sent, and the second line names it in words before saying
 * who the mail was from or to. The subject is the line a person knows the
 * mail by, so it leads.
 */
export function EmailReferenceChip({
  attachment,
  onRemove,
  pressGuard,
  className,
}: EmailReferenceChipProps) {
  const { t, i18n } = useTranslation("chat");
  const { email } = attachment;
  const inbound = email.direction === "inbound";
  const counterpart = inbound ? email.from : (email.to[0] ?? email.from);
  const subject = email.subject.trim() || t("emailReferenceChip.noSubject");
  const name = displayName(counterpart);
  const date = shortDate(email.createdAt, i18n.language);
  /* One whole message per shape, so a translation owns the order and the
     separators, rather than pieces joined in code. */
  const caption = inbound
    ? date
      ? t("emailReferenceChip.captionReceived", { name, date })
      : t("emailReferenceChip.captionReceivedUndated", { name })
    : date
      ? t("emailReferenceChip.captionSent", { name, date })
      : t("emailReferenceChip.captionSentUndated", { name });
  const Icon = inbound ? Mail : Send;

  return (
    <div
      data-testid="email-reference-chip"
      data-direction={email.direction}
      className={cn(
        "flex max-w-[300px] shrink-0 items-center gap-2 rounded-lg bg-[var(--surface-base)] py-1 pl-1 pr-1",
        className,
      )}
      title={t("emailReferenceChip.tooltip", { subject, caption })}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          inbound
            ? "bg-[var(--system-info-weak)]"
            : "bg-[var(--system-positive-weak)]",
        )}
      >
        <Icon className="size-4 text-[var(--content-default)]" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="min-w-0 truncate text-body-small-default leading-4 text-[var(--content-default)]">
          {subject}
        </span>
        <span className="min-w-0 truncate text-label-small-default leading-3 text-[var(--content-tertiary)]">
          {caption}
        </span>
      </div>
      <Button
        variant="ghost"
        size="compact"
        expandOnMobile={false}
        iconOnly={<X />}
        onMouseDown={pressGuard}
        onClick={() => onRemove(attachment.localId)}
        aria-label={t("emailReferenceChip.removeAria", { subject })}
      />
    </div>
  );
}
