/**
 * The button a notification carries when the client can fix what it reports.
 *
 * One renderer for every remediation, so the states a repair goes through
 * (offered, running, done, failed) are decided once instead of per condition.
 * Any detail card can host it: whether an item can be repaired is independent
 * of which card renders it.
 *
 * Renders nothing when the item offers no remediation, or offers one this
 * build has no handler for. Both are ordinary: most notifications report
 * something no client can act on, and a daemon may name a fix that shipped
 * after this client did.
 */
import { useState } from "react";

import { useTranslation } from "@/i18n";
import type { FeedItem } from "@vellumai/assistant-api";
import { Button, Typography } from "@vellumai/design-library";

import { resolveFeedRemediationHandler } from "./feed-remediation-registry";

type RemediationState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

export interface FeedItemRemediationProps {
  item: Pick<FeedItem, "remediation">;
}

export function FeedItemRemediation({ item }: FeedItemRemediationProps) {
  const { t } = useTranslation("home");
  const [state, setState] = useState<RemediationState>({ kind: "idle" });

  const remediation = item.remediation;
  const handler = remediation
    ? resolveFeedRemediationHandler(remediation.action)
    : null;

  if (!remediation || !handler) {
    return null;
  }

  const run = async () => {
    setState({ kind: "running" });
    try {
      await handler();
      setState({ kind: "done" });
    } catch (error) {
      // The reason is the useful half: "sign in to Vellum" and "the assistant
      // is unreachable" need different things from the reader, and a generic
      // failure would hide which one happened.
      setState({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (state.kind === "done") {
    return (
      <Typography
        variant="body-medium-default"
        className="text-[var(--content-secondary)]"
        data-testid="feed-remediation-done"
      >
        {t("feedRemediation.done")}
      </Typography>
    );
  }

  return (
    <div
      className="flex flex-col gap-[var(--app-spacing-sm)]"
      data-testid="feed-remediation"
    >
      <div>
        {/*
          The producer authors the label, since it is the side that knows what
          the fix does. Only the running state is composed here, because that
          is about this button rather than about the repair.
        */}
        <Button
          variant="primary"
          disabled={state.kind === "running"}
          onClick={() => void run()}
        >
          {state.kind === "running"
            ? t("feedRemediation.running")
            : remediation.label}
        </Button>
      </div>

      {state.kind === "failed" ? (
        <Typography
          variant="body-small-default"
          className="text-[var(--system-negative-strong)]"
          data-testid="feed-remediation-error"
        >
          {t("feedRemediation.failed", { reason: state.message })}
        </Typography>
      ) : null}
    </div>
  );
}
