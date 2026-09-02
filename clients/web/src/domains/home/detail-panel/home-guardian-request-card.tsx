import { type ReactNode } from "react";

import {
  CheckCircle,
  CircleSlash,
  Clock,
  ExternalLink,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { useGuardianactionsDecisionPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { Trans, useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { formatRelativeDate } from "@/utils/format-date";
import { handleNativeAnchorClick } from "@/utils/native-anchor";
import {
  type FeedItem,
  type FeedItemGuardianRequest,
  GUARDIAN_TERMINAL_REASON_SUPERSEDED,
} from "@vellumai/assistant-api";
import { Button, Tag, Typography } from "@vellumai/design-library";
import type { TagTone } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

import { HomeMarkdownContent } from "./home-markdown-content";

/** The ask, set in a recessed block so it reads as the quoted request. */
const SUMMARY_BLOCK_CLASS = [
  "rounded-[var(--radius-md)] bg-[var(--surface-sunken)]",
  "p-[var(--app-spacing-md)] leading-normal text-[var(--content-secondary)]",
].join(" ");

/**
 * The tool's identifier, set as the code it is. One token per role rather
 * than a `dark:` pair: `dark:` does not match the velvet theme, so a pair
 * would leave velvet on the light value.
 */
const TOOL_NAME_CLASS = [
  "rounded bg-[var(--surface-base)] px-1.5 py-0.5",
  "font-mono text-body-small-default text-[var(--content-secondary)]",
].join(" ");

export interface HomeGuardianRequestCardProps {
  item: FeedItem;
}

/**
 * Detail card for the canonical guardian-request feed item.
 *
 * Everything renders off the item's `guardianRequest` projection, which
 * the daemon keeps aligned with the gateway-owned request: the source
 * line says where it came from and the summary carries the ask itself.
 * A `pending` approval offers Approve/Reject through the canonical
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
    // fallback shows the body.
    return <HomeMarkdownContent content={item.summary} />;
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

  const receipt = isPending
    ? null
    : resolvedElsewhere
      ? ALREADY_RESOLVED_RECEIPT
      : receiptView(
          decidedLocally
            ? { ...guardianRequest, status: decidedLocally }
            : guardianRequest,
        );
  const ReceiptIcon = receipt?.icon;

  const metaLine = [
    guardianRequest.sourceContextLabel,
    guardianRequest.requesterLabel,
    formatRelativeDate(item.timestamp),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div className="flex flex-col gap-[var(--app-spacing-md)]">
      {/* No title and no status pill here. The panel header above names the
          request, the same way it titles every other notification, and the
          ask itself reads as the quoted block below. */}
      <Typography
        variant="body-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {metaLine}
      </Typography>

      {/* The summary is the daemon's conversation seed: markdown, with a
          question's numbered options on their own lines. Rendered the way
          the generic detail renders its body, so that structure survives
          instead of collapsing into one run-on paragraph. */}
      <HomeMarkdownContent
        content={item.summary}
        className={SUMMARY_BLOCK_CLASS}
      />

      {/* Names the decision rather than the thing: what a person approves
          here is the assistant running this tool. The identifier has no
          display name anywhere in the pipeline, so it renders as the code
          it is, the way the in-conversation confirmation card renders one. */}
      {guardianRequest.toolName ? (
        <Typography
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          <Trans
            ns="home"
            i18nKey={
              isPending
                ? "homeGuardianRequestCard.toolRequesting"
                : "homeGuardianRequestCard.toolRequested"
            }
            values={{ toolName: guardianRequest.toolName }}
            components={{ code: <code className={TOOL_NAME_CLASS} /> }}
          />
        </Typography>
      ) : null}

      {/* The meta line dates the request; a decision can land days later,
          so the receipt carries its own time rather than letting the
          request's stand for both. */}
      {receipt && ReceiptIcon ? (
        <div
          data-testid="guardian-request-receipt"
          className="flex flex-wrap items-center gap-[var(--app-spacing-sm)]"
        >
          <Tag tone={receipt.tone} leftIcon={<ReceiptIcon />}>
            {t(receipt.labelKey)}
          </Tag>
          {guardianRequest.decidedAt ? (
            <Typography
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
            >
              {formatRelativeDate(guardianRequest.decidedAt)}
            </Typography>
          ) : null}
        </div>
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

      {/* One link out, to where the request came from. The Slack DM card is
          a delivery of this same request, so linking it from here would
          send a person to a copy of the surface they are already on. */}
      {guardianRequest.sourceUrl ? (
        <ExternalTextLink
          href={guardianRequest.sourceUrl}
          icon={<ExternalLink className="size-2.5" />}
          label={t("homeGuardianRequestCard.viewSourceThread")}
        />
      ) : null}
    </div>
  );
}

interface ExternalTextLinkProps {
  href: string;
  icon: ReactNode;
  label: string;
}

/**
 * Low-chrome labelled action opening an external target (a Slack thread, a
 * permalink). The `link` variant is for links set inside running text: it
 * lays out `inline` and inherits its type from the paragraph around it, so
 * it can neither space a leading icon nor size itself standing alone. A
 * compact ghost button is the primitive for a standalone secondary action.
 *
 * `self-start` because the card is a flex column, which would otherwise
 * stretch the button to the full width and centre its label.
 */
function ExternalTextLink({ href, icon, label }: ExternalTextLinkProps) {
  return (
    <Button
      asChild
      variant="ghost"
      size="compact"
      leftIcon={icon}
      className="self-start"
    >
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

type ReceiptLabelKey =
  | "homeGuardianRequestCard.receipt.approved"
  | "homeGuardianRequestCard.receipt.rejected"
  | "homeGuardianRequestCard.receipt.expired"
  | "homeGuardianRequestCard.receipt.superseded"
  | "homeGuardianRequestCard.receipt.leftUnverified"
  | "homeGuardianRequestCard.receipt.cancelled"
  | "homeGuardianRequestCard.receipt.alreadyResolved";

interface ReceiptView {
  labelKey: ReceiptLabelKey;
  tone: TagTone;
  icon: LucideIcon;
}

/** The receipt for a decision another surface applied first. */
const ALREADY_RESOLVED_RECEIPT: ReceiptView = {
  labelKey: "homeGuardianRequestCard.receipt.alreadyResolved",
  tone: "neutral",
  icon: CircleSlash,
};

/**
 * Receipt for a terminal projection, as the outcome tag this app uses
 * for a settled thing. Only a decision a person made carries a tone: an
 * approval is positive, a rejection negative, and an outcome nobody
 * chose (expired, auto-denied by a newer message, a contact left
 * unverified) is neutral, because it reports rather than judges.
 *
 * The decider is never named. A guardian request is the guardian's
 * alone to decide, so the only name it could carry is the name of the
 * person reading it.
 */
function receiptView(
  guardianRequest: Pick<
    FeedItemGuardianRequest,
    "status" | "decidedAction" | "terminalReason"
  >,
): ReceiptView {
  const { status, decidedAction, terminalReason } = guardianRequest;
  if (status === "approved") {
    return {
      labelKey: "homeGuardianRequestCard.receipt.approved",
      tone: "positive",
      icon: CheckCircle,
    };
  }
  if (status === "denied") {
    if (terminalReason === GUARDIAN_TERMINAL_REASON_SUPERSEDED) {
      return {
        labelKey: "homeGuardianRequestCard.receipt.superseded",
        tone: "neutral",
        icon: CircleSlash,
      };
    }
    if (decidedAction === "leave_unverified") {
      return {
        labelKey: "homeGuardianRequestCard.receipt.leftUnverified",
        tone: "neutral",
        icon: CircleSlash,
      };
    }
    return {
      labelKey: "homeGuardianRequestCard.receipt.rejected",
      tone: "negative",
      icon: XCircle,
    };
  }
  if (status === "expired") {
    return {
      labelKey: "homeGuardianRequestCard.receipt.expired",
      tone: "neutral",
      icon: Clock,
    };
  }
  return {
    labelKey: "homeGuardianRequestCard.receipt.cancelled",
    tone: "neutral",
    icon: CircleSlash,
  };
}
