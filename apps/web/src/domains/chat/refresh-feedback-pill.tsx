
import { useEffect, useState } from "react";

import { ChatPill } from "@/domains/chat/components/chat-pill";

export type RefreshFeedback =
  | { kind: "no-change" }
  | { kind: "new-messages"; count: number }
  | { kind: "error"; message?: string };

interface RefreshFeedbackPillProps {
  /** When non-null, the pill becomes visible and starts its
   *  auto-dismiss timer. The caller is responsible for clearing the
   *  feedback (passing `null`) on dismiss. The component calls
   *  `onDismiss` when its internal timer elapses. */
  feedback: RefreshFeedback | null;
  /** Called when the auto-dismiss timer elapses. */
  onDismiss: () => void;
  /** Optional retry handler — the error pill is tappable when set. */
  onRetry?: () => void;
}

const NO_CHANGE_DURATION_MS = 1200;
const NEW_MESSAGES_DURATION_MS = 1400;
const ERROR_DURATION_MS = 3000;

function durationFor(feedback: RefreshFeedback): number {
  switch (feedback.kind) {
    case "no-change":
      return NO_CHANGE_DURATION_MS;
    case "new-messages":
      return NEW_MESSAGES_DURATION_MS;
    case "error":
      return ERROR_DURATION_MS;
  }
}

function labelFor(feedback: RefreshFeedback): string {
  switch (feedback.kind) {
    case "no-change":
      return "Up to date";
    case "new-messages":
      return feedback.count === 1
        ? "1 new message"
        : `${feedback.count} new messages`;
    case "error":
      return "Couldn't refresh — tap to retry";
  }
}

export function RefreshFeedbackPill({
  feedback,
  onDismiss,
  onRetry,
}: RefreshFeedbackPillProps) {
  // Track the active feedback locally so the pill stays mounted long
  // enough for its fade-out animation. A new feedback resets the timer.
  const [active, setActive] = useState<RefreshFeedback | null>(feedback);

  useEffect(() => {
    if (feedback === null) {
      setActive(null);
      return;
    }
    setActive(feedback);
    const duration = durationFor(feedback);
    const timer = setTimeout(() => {
      onDismiss();
    }, duration);
    return () => clearTimeout(timer);
  }, [feedback, onDismiss]);

  if (!active) return null;

  const isError = active.kind === "error";
  const interactive = isError && !!onRetry;
  const tone = isError ? "negative" : "default";
  const label = labelFor(active);

  if (interactive) {
    return (
      <ChatPill tone={tone} onClick={onRetry} ariaLabel="Retry refresh">
        {label}
      </ChatPill>
    );
  }

  return (
    <ChatPill tone={tone} role="status" ariaLive="polite">
      {label}
    </ChatPill>
  );
}
