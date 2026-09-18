import {
  ArrowLeft,
  Loader2,
  MessageSquareText,
  Paperclip,
  Send,
} from "lucide-react";

import { Button, cn } from "@vellumai/design-library";

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
 * The reading pane. Subject first, then who and when, then the body as the
 * plain text the platform stores, then the attachments. An inbound message
 * ends in the one action this surface offers, asking the assistant to reply,
 * because the composer lives in chat rather than here.
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

  return (
    <article
      className={cn("flex min-h-0 flex-col overflow-y-auto", className)}
      aria-labelledby={`email-subject-${email.id}`}
    >
      <div className="flex flex-col gap-5 px-6 py-5">
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

        <h2
          id={`email-subject-${email.id}`}
          className="text-title-medium text-[var(--content-emphasised)]"
        >
          {email.subject || t("emailListRow.noSubject")}
        </h2>

        <div className="flex items-start gap-3">
          <SenderDisc participant={email.from} size={40} />
          <dl className="flex min-w-0 flex-1 flex-col gap-0.5 text-body-small-lighter">
            <div className="flex min-w-0 gap-2">
              <dt className="w-10 shrink-0 text-[var(--content-tertiary)]">
                {t("emailDetail.from")}
              </dt>
              <dd className="min-w-0 truncate text-[var(--content-default)]">
                {participantLabel(email.from)}
              </dd>
            </div>
            <div className="flex min-w-0 gap-2">
              <dt className="w-10 shrink-0 text-[var(--content-tertiary)]">
                {t("emailDetail.to")}
              </dt>
              <dd className="min-w-0 truncate text-[var(--content-default)]">
                {email.to.map(participantLabel).join(", ")}
              </dd>
            </div>
          </dl>
          <time
            dateTime={email.createdAt}
            className="shrink-0 text-body-small-lighter text-[var(--content-tertiary)]"
          >
            {formatEmailDetailTime(email.createdAt, i18n.language)}
          </time>
        </div>

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
            <div className="flex flex-col gap-4 text-body-medium-lighter text-[var(--content-default)]">
              {detail.body.split(/\n{2,}/).map((paragraph, index) => (
                <p key={index} className="whitespace-pre-line">
                  {paragraph}
                </p>
              ))}
            </div>

            {detail.attachments.length > 0 ? (
              <section className="flex flex-col gap-2">
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

        {/* The reply action exists only when something will act on it: a
            button that looks live and does nothing is worse than none. */}
        {inbound && onAskToReply ? (
          <footer className="flex items-center gap-3 pt-2">
            <Button
              variant="outlined"
              leftIcon={<MessageSquareText />}
              onClick={() => onAskToReply(email)}
            >
              {t("emailDetail.askToReply", { name: assistantName })}
            </Button>
          </footer>
        ) : !inbound ? (
          <footer className="flex items-center gap-3 pt-2">
            <span className="flex items-center gap-1.5 text-body-small-lighter text-[var(--content-tertiary)]">
              <Send className="size-3.5" aria-hidden="true" />
              {t("emailDetail.sentBy", { name: assistantName })}
            </span>
          </footer>
        ) : null}
      </div>
    </article>
  );
}
