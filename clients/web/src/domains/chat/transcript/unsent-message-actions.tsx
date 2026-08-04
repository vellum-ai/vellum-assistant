import { Button } from "@vellumai/design-library/components/button";
import { AlertCircle } from "lucide-react";

// ---------------------------------------------------------------------------
// Actions under a message whose send did not reach the server
// ---------------------------------------------------------------------------
//
// A failed send keeps its row in the transcript instead of being rolled back
// into the composer, so the text and any attachments stay where the user put
// them. This strip is what tells them it did not go and gives them a way to
// act on it. Retry resends the same row under its original identity, which is
// what lets the daemon deduplicate a send it received but never answered for;
// discard drops it.

export interface UnsentMessageActionsProps {
  onRetry: () => void;
  onDiscard: () => void;
}

export function UnsentMessageActions({
  onRetry,
  onDiscard,
}: UnsentMessageActionsProps) {
  return (
    <div
      data-testid="unsent-message-actions"
      className="mt-1 flex items-center justify-end gap-2 text-body-small-default text-[var(--content-secondary)]"
    >
      <AlertCircle aria-hidden className="size-3.5" />
      <span>Not sent</span>
      <Button variant="ghost" size="compact" onClick={onRetry}>
        Retry
      </Button>
      <Button variant="ghost" size="compact" onClick={onDiscard}>
        Discard
      </Button>
    </div>
  );
}
