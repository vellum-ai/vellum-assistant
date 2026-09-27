import {
  ArrowLeft,
  Check,
  Copy,
  Loader2,
  MessageSquareText,
  Paperclip,
} from "lucide-react";

import { Button, cn } from "@vellumai/design-library";

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";

import {
  formatAttachmentSize,
  formatEmailDetailTime,
} from "../format-email-time";
import type { EmailDetailData, EmailParticipant, InboxEmail } from "../types";
import { SenderDisc } from "./sender-disc";

function participantLabel(participant: EmailParticipant): string {
  const name = participant.name?.trim();
  return name ? `${name} <${participant.address}>` : participant.address;
}

/**
 * The body and attachments as the pane has them: carried on the row, still
 * being fetched, fetched, or failed.
 */
export type EmailDetailState =
  | { status: "loading" }
  | { status: "error" }
  | ({ status: "ready" } & EmailDetailData);

export interface EmailDetailProps {
  email: InboxEmail;
  detail: EmailDetailState;
  assistantName: string;
  /** Shown only where the list is hidden behind the reading pane. */
  onBack?: () => void;
  /** Hands the message to chat so the assistant can draft a reply. */
  onAskToReply?: (email: InboxEmail) => void;
  className?: string;
}

/**
 * The reading pane, laid out as the design draws an open message: a header
 * row with the sender's disc, the subject over the full date, and the
 * actions on the trailing edge (asking the assistant to reply, and copying
 * the message); then the From and To lines between two hairlines; then the
 * body as the plain text the platform stores, and the attachments. The
 * reply action exists only on an inbound message with something to act on
 * it, because the composer lives in chat rather than here.
 */
export function EmailDetail({
  email,
  detail,
  assistantName,
  onBack,
  onAskToReply,
  className,
}: EmailDetailProps) {
  const { t, i18n } = useTranslation("assistant-inbox");
  const inbound = email.direction === "inbound";
  const subject = email.subject || t("emailListRow.noSubject");
  const { copied, copy } = useCopyToClipboard({
    errorMessage: t("emailDetail.copyFailed"),
  });
  const copyEmail = () => {
    if (detail.status !== "ready") {
      return;
    }
    copy(`${subject}\n\n${detail.body}`);
  };

  return (
    <article
      className={cn("flex min-h-0 flex-col overflow-y-auto", className)}
      aria-labelledby={`email-subject-${email.id}`}
    >
      <div className="flex flex-col gap-4 px-5 py-5">
        {onBack ? (
          /* The list is beside the pane from `md` up, so the way back is
             only drawn where the pane has covered it. */
          <div className="md:hidden">
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<ArrowLeft />}
              onClick={onBack}
            >
              {t("assistantInboxPage.backToList")}
            </Button>
          </div>
        ) : null}

        <header className="flex flex-wrap items-center gap-2">
          <SenderDisc participant={email.from} size={44} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2
              id={`email-subject-${email.id}`}
              className="min-w-0 break-words text-title-medium text-[var(--content-emphasised)]"
            >
              {subject}
            </h2>
            <time
              dateTime={email.createdAt}
              className="text-body-medium-lighter text-[var(--content-tertiary)]"
            >
              {formatEmailDetailTime(email.createdAt, i18n.language)}
            </time>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {inbound && onAskToReply ? (
              <Button
                variant="outlined"
                leftIcon={<MessageSquareText />}
                onClick={() => onAskToReply(email)}
              >
                {t("emailDetail.askToReply", { name: assistantName })}
              </Button>
            ) : null}
            <Button
              variant="outlined"
              iconOnly={copied ? <Check /> : <Copy />}
              disabled={detail.status !== "ready"}
              onClick={copyEmail}
              aria-label={t("emailDetail.copyEmail")}
              title={
                copied ? t("emailDetail.copied") : t("emailDetail.copyEmail")
              }
            />
          </div>
        </header>

        <dl className="flex flex-col gap-3 border-y border-[var(--border-hover)] py-3 text-body-medium-lighter">
          <div className="flex min-w-0 items-center gap-4">
            <dt className="w-10 shrink-0 text-[var(--content-tertiary)]">
              {t("emailDetail.from")}
            </dt>
            <dd className="min-w-0 truncate text-body-medium-default text-[var(--content-secondary)]">
              {participantLabel(email.from)}
            </dd>
          </div>
          <div className="flex min-w-0 items-center gap-4">
            <dt className="w-10 shrink-0 text-[var(--content-tertiary)]">
              {t("emailDetail.to")}
            </dt>
            <dd className="min-w-0 truncate text-body-medium-default text-[var(--content-secondary)]">
              {email.to.map(participantLabel).join(", ")}
            </dd>
          </div>
        </dl>

        {detail.status === "loading" ? (
          <p
            role="status"
            className="flex items-center gap-2 text-body-small-lighter text-[var(--content-tertiary)]"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t("emailDetail.loading")}
          </p>
        ) : detail.status === "error" ? (
          <p className="text-body-small-lighter text-[var(--system-negative-strong)]">
            {t("emailDetail.loadFailed")}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-[18px] text-body-medium-lighter text-[var(--content-default)]">
              {detail.body.split(/\n{2,}/).map((paragraph, index) => (
                <p key={index} className="whitespace-pre-line">
                  {paragraph}
                </p>
              ))}
            </div>

            {detail.attachments.length > 0 ? (
              <section className="flex flex-col gap-2 pt-1">
                <h3 className="text-label-small-default text-[var(--content-tertiary)]">
                  {t("emailDetail.attachments")}
                </h3>
                <ul className="flex flex-wrap gap-2">
                  {detail.attachments.map((attachment) => (
                    <li
                      key={attachment.id}
                      className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2 text-body-small-lighter text-[var(--content-default)]"
                    >
                      <Paperclip
                        className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
                        aria-hidden="true"
                      />
                      <span className="truncate">{attachment.filename}</span>
                      <span className="shrink-0 text-[var(--content-tertiary)]">
                        {formatAttachmentSize(
                          attachment.sizeBytes,
                          i18n.language,
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}
