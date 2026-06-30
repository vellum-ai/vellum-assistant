// Connects a {@link BackgroundProcessDescriptor} to the generic
// {@link InlineProcessCard}: subscribes to the descriptor's per-id
// `useCardSummary` hook and projects the result into the shared card, supplying
// the descriptor's leading icon, open-affordance label, and custom count slot
// (`descriptor.renderCount`). Returns `null` in the spawn race (no card-worthy
// state yet), matching the bespoke cards it replaces.
//
// The descriptor hook MUST run inside a component (not a bare `.map` callback),
// so each row is its own component subscribing to its own id.
//
// `onOpen` / `onStop` are threaded from the caller: the transcript wires its own
// per-kind open/stop handlers, while the active-process overlay wires the
// descriptor's `onOpenDetail` / `onStop`. Both call sites render through this
// one row component.

import type { BackgroundProcessDescriptor } from "@/domains/chat/process-registry/types";
import { InlineProcessCard } from "@/domains/chat/process-registry/inline-process-card";

export interface InlineProcessCardRowProps {
  /** Descriptor whose store/projection drives this row. */
  descriptor: BackgroundProcessDescriptor;
  /** Process id within the descriptor's kind. */
  id: string;
  /** Opens the process's detail panel; omit to make the leading cluster inert. */
  onOpen?: () => void;
  /** Stops the in-flight process; omit to hide the stop button. */
  onStop?: () => void;
  /** Accessible label for the stop button; defaults to the card's `"Stop"`. */
  stopAriaLabel?: string;
  /** `data-testid` for the root row. */
  testId?: string;
}

export function InlineProcessCardRow({
  descriptor,
  id,
  onOpen,
  onStop,
  stopAriaLabel,
  testId,
}: InlineProcessCardRowProps) {
  const summary = descriptor.useCardSummary(id);
  if (!summary) return null;
  return (
    <InlineProcessCard
      summary={summary}
      leadingIcon={descriptor.renderCardLeading(id)}
      openAriaLabel={descriptor.openCardAriaLabel}
      onOpen={onOpen}
      onStop={onStop}
      stopAriaLabel={stopAriaLabel}
      countSlot={descriptor.renderCount?.(id)}
      testId={testId}
    />
  );
}
