/**
 * Presentational in-chat offer card that proposes cleaning the user's inbox.
 *
 * Shows a title, a short description, and two actions: a primary "Yes, clean
 * my inbox" button (`onAccept`) and an outlined "Not now" button (`onDecline`).
 * Both buttons are disabled while `busy` is true (e.g. during the OAuth/skill
 * kickoff that the accept flow triggers).
 *
 * Purely presentational — no data fetching, store reads, or network access.
 */

import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { Button, Card } from "@vellum/design-library";

export interface InboxCleanupOfferCardProps {
  onAccept: () => void;
  onDecline: () => void;
  /** Disables buttons while the accept flow (OAuth/skill kickoff) is running. */
  busy?: boolean;
}

export function InboxCleanupOfferCard({
  onAccept,
  onDecline,
  busy = false,
}: InboxCleanupOfferCardProps): ReactNode {
  return (
    <div className="max-w-sm" style={{ animation: "fadeInUp 0.3s ease-out both" }}>
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-body-medium-default text-[color:var(--content-default)]">
            <Sparkles className="h-4 w-4 text-[var(--content-secondary)]" />
            Want me to clean your inbox?
          </div>
          <div className="text-label-small-default text-[color:var(--content-tertiary)]">
            I&apos;ll connect Gmail and archive the clutter — you can undo
            anything.
          </div>
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              size="regular"
              fullWidth
              disabled={busy}
              onClick={onAccept}
            >
              Yes, clean my inbox
            </Button>
            <Button
              variant="outlined"
              size="regular"
              fullWidth
              disabled={busy}
              onClick={onDecline}
            >
              Not now
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
