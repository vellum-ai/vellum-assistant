import { ArrowUp, MoreHorizontal, Pencil, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { useSupportsQueueSteering } from "@/lib/backwards-compat/use-supports-queue-steering";
import { isPointerCoarse } from "@/utils/pointer";
import { Button } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedMessagesDrawerProps {
  queuedMessages: DisplayMessage[];
  onCancelMessage: (messageId: string) => void;
  onCancelAll: () => void;
  onSteer: (messageId: string) => void;
  onEditTail: () => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface QueuedMessageRowProps {
  message: DisplayMessage;
  position: number;
  isTail: boolean;
  onCancel: () => void;
  onSteer: () => void;
  onEdit: () => void;
  /** Coarse pointer: this row's controls stay behind a reveal tap. */
  twoStep: boolean;
  revealed: boolean;
  onReveal: () => void;
}

function QueuedMessageRow({
  message,
  position,
  isTail,
  onCancel,
  onSteer,
  onEdit,
  twoStep,
  revealed,
  onReveal,
}: QueuedMessageRowProps) {
  const preview = useMemo(() => messagePlainText(message), [message]);
  const supportsSteer = useSupportsQueueSteering();
  const awaitingReveal = twoStep && !revealed;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md py-0.5 md:gap-2 md:px-2 md:py-1.5",
        awaitingReveal && "cursor-pointer",
      )}
      // Tapping anywhere on the row is the first of the two steps, so the
      // reveal target is the whole row rather than only the small icon. The
      // icon below is the accessible control; this is a convenience target.
      onClick={awaitingReveal ? onReveal : undefined}
    >
      {/* Accent bar */}
      <div className="h-4 w-0.5 shrink-0 rounded-full bg-[var(--system-mid-strong)] md:h-5" />

      {/* Position pill */}
      <span className="shrink-0 text-label-medium-default text-[var(--content-tertiary)]">
        #{position}
      </span>

      {/* Message preview */}
      <span className="min-w-0 flex-1 truncate text-body-small-default text-[var(--content-secondary)]">
        {preview}
      </span>

      {/* Action icons */}
      <div className="flex shrink-0 items-center gap-0.5">
        {awaitingReveal ? (
          <Button
            variant="ghost"
            size="compact"
            className="max-md:h-6 max-md:w-6 max-md:bg-transparent max-md:rounded-md"
            iconOnly={<MoreHorizontal className="h-3.5 w-3.5" />}
            onClick={onReveal}
            aria-label="Show queued message actions"
          />
        ) : (
          <>
            {supportsSteer && (
              <Button
                variant="ghost"
                size="compact"
                className="max-md:h-6 max-md:w-6 max-md:bg-transparent max-md:rounded-md"
                iconOnly={<ArrowUp className="h-3.5 w-3.5" />}
                onClick={onSteer}
                aria-label="Push to agent"
              />
            )}
            {isTail && (
              <Button
                variant="ghost"
                size="compact"
                className="max-md:h-6 max-md:w-6 max-md:bg-transparent max-md:rounded-md"
                iconOnly={<Pencil className="h-3.5 w-3.5" />}
                onClick={onEdit}
                aria-label="Edit queued message"
              />
            )}
            <Button
              variant="ghost"
              size="compact"
              className="max-md:h-6 max-md:w-6 max-md:bg-transparent max-md:rounded-md"
              iconOnly={<X className="h-3.5 w-3.5" />}
              onClick={onCancel}
              aria-label="Cancel queued message"
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * The pending-queue list shown above the composer, with per-row steer, edit,
 * and cancel controls.
 *
 * Every one of those controls is destructive: cancel and steer both take the
 * message out of the queue, and edit moves its text back into the composer
 * after cancelling it. On a fine pointer they are safe to leave visible, since
 * a mouse click lands where it is aimed. On a coarse pointer they are not: the
 * rows are small, the drawer sits directly above the composer, and a stray
 * thumb on the way to the text field would otherwise fire one of them outright.
 * So touch gets a two-step reveal (one tap arms a single row, the next
 * activates a control on it), and a tap anywhere else disarms it again.
 */
export function QueuedMessagesDrawer({
  queuedMessages,
  onCancelMessage,
  onCancelAll,
  onSteer,
  onEditTail,
}: QueuedMessagesDrawerProps): ReactNode {
  // Read once per mount: the primary pointer does not change under a live
  // component, and re-reading per render would fight the reveal state.
  const twoStep = useMemo(() => isPointerCoarse(), []);
  const [revealedMessageId, setRevealedMessageId] = useState<string | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleCancelMessage = useCallback(
    (messageId: string) => {
      onCancelMessage(messageId);
    },
    [onCancelMessage],
  );

  // A tap outside the drawer disarms the revealed row, so the controls are
  // never left armed behind an unrelated interaction. Taps on another row
  // re-target the reveal instead, which the row handler already does.
  useEffect(() => {
    if (revealedMessageId === null) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const container = containerRef.current;
      if (
        container &&
        event.target instanceof Node &&
        container.contains(event.target)
      ) {
        return;
      }
      setRevealedMessageId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [revealedMessageId]);

  // A row that leaves the queue must not keep the reveal armed for whatever
  // row inherits its position.
  useEffect(() => {
    if (
      revealedMessageId !== null &&
      !queuedMessages.some((m) => m.id === revealedMessageId)
    ) {
      setRevealedMessageId(null);
    }
  }, [queuedMessages, revealedMessageId]);

  if (queuedMessages.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="animate-in slide-in-from-bottom-2 fade-in w-full duration-200"
    >
      <div className="mb-1 rounded-xl border border-[var(--border-base)] bg-[var(--surface-overlay)] px-2 py-1 md:mb-2 md:px-3 md:py-2">
        {/* Header */}
        <div className="mb-0.5 flex items-center justify-between md:mb-1">
          <span className="text-label-medium-default text-[var(--content-secondary)]">
            Queue &middot; {queuedMessages.length}
          </span>
          <Button
            variant="ghost"
            size="compact"
            onClick={onCancelAll}
            aria-label="Cancel all queued messages"
          >
            Cancel all
          </Button>
        </div>

        {/* Rows */}
        <div className="flex flex-col gap-0.5">
          {queuedMessages.map((msg, idx) => (
            <QueuedMessageRow
              key={msg.id}
              message={msg}
              position={idx + 1}
              isTail={idx === queuedMessages.length - 1}
              onCancel={() => handleCancelMessage(msg.id)}
              onSteer={() => onSteer(msg.id)}
              onEdit={onEditTail}
              twoStep={twoStep}
              revealed={revealedMessageId === msg.id}
              onReveal={() => setRevealedMessageId(msg.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
