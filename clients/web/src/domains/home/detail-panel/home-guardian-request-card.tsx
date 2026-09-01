import { useGuardianactionsDecisionPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { type TFunction, useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { handleNativeAnchorClick } from "@/utils/native-anchor";
import { formatRelativeDate } from "@/utils/format-date";
import {
  type FeedItem,
  type FeedItemGuardianRequest,
  GUARDIAN_TERMINAL_REASON_SUPERSEDED,
} from "@vellumai/assistant-api";
import { Button, Tag, Typography } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";
import { ExternalLink, MessageCircle } from "lucide-react";
import { type ReactNode } from "react";

import { resolveFeedItemTitle } from "../utils";

export interface HomeGuardianRequestCardProps {
  item: FeedItem;
}

/**
 * Detail card for the canonical guardian-request feed item.
 *
 * Everything renders off the item's `guardianRequest` projection, which
 * the daemon keeps aligned with the gateway-owned request: a status pill
 * says whether the request still needs the user, the title and source
 * line say what and where, and the summary carries the plain-language
 * ask. A `pending` approval offers Approve/Reject through the canonical
 * decision route, a `pending` question points at the source conversation
 * (the host panel's "Go to Conversation" link is the way there), and a
 * terminal status renders as a receipt in place of the buttons. A
 * decision that comes back not-applied means another surface resolved
 * the request first; the projection converges through the feed's own
 * refresh, so the card only has to say so.
 */
export function HomeGuardianRequestCard({
  item,
}: HomeGuardianRequestCardProps) {
  const { t } = useTranslation("home");
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const guardianRequest = item.guardianRequest;

  const decision = useGuardianactionsDecisionPostMutation({
    onError: (err) => {
      captureError(err, { context: "guardian-request-card-decision" });
      toast.error(t("homeGuardianRequestCard.decisionFailed"));
    },
  });

  if (!guardianRequest) {
    // The panel header above this card already renders the title, so this
    // fallback shows the body. Matches HomeToolPermissionCard.
    return (
      <Typography
        variant="body-medium-default"
        className="text-[var(--content-secondary)]"
      >
        {item.summary}
      </Typography>
    );
  }

  const decide = (action: "approve_once" | "reject") => {
    if (!assistantId) {
      return;
    }
    decision.mutate({
      path: { assistant_id: assistantId },
      body: { requestId: guardianRequest.requestId, action },
    });
  };

  const decidedLocally =
    decision.data?.applied === true
      ? decision.variables?.body?.action === "approve_once"
        ? ("approved" as const)
        : ("denied" as const)
      : null;
  const resolvedElsewhere = decision.data?.applied === false;

  const isPending =
    guardianRequest.status === "pending" &&
    !decidedLocally &&
    !resolvedElsewhere;
  const showsApprovalButtons =
    isPending && guardianRequest.intent === "approval";

  const metaLine = [
    guardianRequest.sourceContextLabel,
    guardianRequest.requesterLabel,
    formatRelativeDate(item.timestamp),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div className="flex flex-col gap-[var(--app-spacing-md)]">
      <div>
        {isPending ? (
          <Tag
            tone="warning"
            className="uppercase tracking-wide"
            leftIcon={
              <span className="block h-1.5 w-1.5 rounded-full bg-[var(--system-mid-strong)] motion-safe:animate-pulse" />
            }
          >
            {t("homeGuardianRequestCard.statusNeedsAttention")}
          </Tag>
        ) : (
          <Tag
            tone={
              (decidedLocally ?? guardianRequest.status) === "approved"
                ? "positive"
                : "neutral"
            }
            className="uppercase tracking-wide"
            data-testid="guardian-request-status-resolved"
          >
            {t("homeGuardianRequestCard.statusResolved")}
          </Tag>
        )}
      </div>

      <div className="flex flex-col gap-[var(--app-spacing-xxs)]">
        <Typography
          variant="title-small"
          className="leading-snug text-[var(--content-default)]"
        >
          {resolveFeedItemTitle(item)}
        </Typography>
        {metaLine ? (
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            {metaLine}
          </Typography>
        ) : null}
      </div>

      <Typography
        variant="body-medium-default"
        className="rounded-[var(--radius-md)] bg-[var(--surface-hover)] p-[var(--app-spacing-md)] leading-normal text-[var(--content-secondary)]"
      >
        {item.summary}
      </Typography>

      {guardianRequest.toolName ? (
        <div className="flex flex-col gap-[var(--app-spacing-xxs)]">
          <Typography
            variant="body-small-emphasised"
            className="uppercase tracking-wide text-[var(--content-tertiary)]"
          >
            {t("homeGuardianRequestCard.tool")}
          </Typography>
          <Typography
            variant="body-small-default"
            className="break-all font-mono text-[var(--content-secondary)]"
          >
            {guardianRequest.toolName}
          </Typography>
        </div>
      ) : null}

      {!isPending ? (
        <Typography
          variant="body-small-emphasised"
          className="text-[var(--content-default)]"
          data-testid="guardian-request-receipt"
        >
          {resolvedElsewhere
            ? t("homeGuardianRequestCard.alreadyResolved")
            : receiptLabel(
                t,
                decidedLocally
                  ? { ...guardianRequest, status: decidedLocally }
                  : guardianRequest,
              )}
        </Typography>
      ) : null}

      {showsApprovalButtons ? (
        <div className="flex flex-wrap gap-[var(--app-spacing-sm)]">
          <Button
            variant="primary"
            disabled={decision.isPending || !assistantId}
            onClick={() => decide("approve_once")}
          >
            {t("homeGuardianRequestCard.approve")}
          </Button>
          <Button
            variant="outlined"
            disabled={decision.isPending || !assistantId}
            onClick={() => decide("reject")}
          >
            {t("homeGuardianRequestCard.reject")}
          </Button>
        </div>
      ) : null}

      {isPending && guardianRequest.intent === "question" ? (
        <Typography
          variant="body-medium-lighter"
          className="text-[var(--content-secondary)]"
        >
          {t("homeGuardianRequestCard.answerHint")}
        </Typography>
      ) : null}

      {guardianRequest.sourceUrl || guardianRequest.slackCardUrl ? (
        <div className="flex flex-wrap items-center gap-[var(--app-spacing-md)]">
          {guardianRequest.sourceUrl ? (
            <ExternalTextLink
              href={guardianRequest.sourceUrl}
              icon={<ExternalLink className="size-4" />}
              label={t("homeGuardianRequestCard.viewSourceThread")}
            />
          ) : null}
          {guardianRequest.slackCardUrl ? (
            <ExternalTextLink
              href={guardianRequest.slackCardUrl}
              icon={<MessageCircle className="size-4" />}
              label={t("homeGuardianRequestCard.openInSlack")}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface ExternalTextLinkProps {
  href: string;
  icon: ReactNode;
  label: string;
}

/** Inline link opening an external target (a Slack thread, a permalink). */
function ExternalTextLink({ href, icon, label }: ExternalTextLinkProps) {
  return (
    <Button asChild variant="link" leftIcon={icon}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => handleNativeAnchorClick(event, href)}
      >
        {label}
      </a>
    </Button>
  );
}

/**
 * Receipt sentence for a terminal projection. Each outcome is its own
 * whole-sentence key (never a select branch), with the by-name variant
 * used only when the daemon attributed the decision to a person. A
 * `denied` reached without a person's decision reads by its cause:
 * `superseded` when a newer message auto-denied it, the neutral park
 * label for a left-unverified contact.
 */
function receiptLabel(
  t: TFunction<"home">,
  guardianRequest: Pick<
    FeedItemGuardianRequest,
    "status" | "decidedAction" | "decidedByLabel" | "terminalReason"
  >,
): string {
  const { status, decidedAction, decidedByLabel, terminalReason } =
    guardianRequest;
  if (status === "approved") {
    return decidedByLabel
      ? t("homeGuardianRequestCard.receipt.approvedBy", {
          name: decidedByLabel,
        })
      : t("homeGuardianRequestCard.receipt.approved");
  }
  if (status === "denied") {
    if (terminalReason === GUARDIAN_TERMINAL_REASON_SUPERSEDED) {
      return t("homeGuardianRequestCard.receipt.superseded");
    }
    if (decidedAction === "leave_unverified") {
      return t("homeGuardianRequestCard.receipt.leftUnverified");
    }
    return decidedByLabel
      ? t("homeGuardianRequestCard.receipt.rejectedBy", {
          name: decidedByLabel,
        })
      : t("homeGuardianRequestCard.receipt.rejected");
  }
  if (status === "expired") {
    return t("homeGuardianRequestCard.receipt.expired");
  }
  return t("homeGuardianRequestCard.receipt.cancelled");
}
