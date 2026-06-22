
import { ArrowUp, Pencil, X } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { Button } from "@vellumai/design-library";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedMessagesDrawerProps {
  queuedMessages: DisplayMessage[];
  onCancelMessage: (messageId: string) => void;
  onCancelAll: () => void;
  onSteer: (messageId: string) => void;
  showSteer: boolean;
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
  showSteer: boolean;
  onEdit: () => void;
}

function QueuedMessageRow({
  message,
  position,
  isTail,
  onCancel,
  onSteer,
  showSteer,
  onEdit,
}: QueuedMessageRowProps) {
  const preview = useMemo(
    () => messagePlainText(message),
    [message],
  );
  return (
    <div className="flex items-center gap-1.5 rounded-md py-0.5 md:gap-2 md:px-2 md:py-1.5">
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
        {showSteer && (
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function QueuedMessagesDrawer({
  queuedMessages,
  onCancelMessage,
  onCancelAll,
  onSteer,
  showSteer,
  onEditTail,
}: QueuedMessagesDrawerProps): ReactNode {
  const handleCancelMessage = useCallback(
    (messageId: string) => {
      onCancelMessage(messageId);
    },
    [onCancelMessage],
  );

  if (queuedMessages.length === 0) {
    return null;
  }

  return (
    <div className="animate-in slide-in-from-bottom-2 fade-in w-full duration-200">
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
              showSteer={showSteer}
              onEdit={onEditTail}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
