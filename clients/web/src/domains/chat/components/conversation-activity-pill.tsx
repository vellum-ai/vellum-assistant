/**
 * Header control listing the current conversation's agent sessions — its
 * subagents and ACP runs — so a session can be reopened after it scrolls out of
 * the transcript, running or finished.
 *
 * Deliberately a sibling of {@link ConversationAssetsPill} rather than a section
 * inside it, and built from the same parts: the same ghost/`active` pill
 * trigger, the same desktop-popover / mobile-bottom-sheet split, and (for the
 * rows) the process registry's own `InlineProcessCardRow`, descriptors, and
 * `onOpenDetail` routing. Nothing here is a new visual primitive.
 *
 * The trigger reads live only while something is running: the running case
 * borrows the transcript's `ThreeDotIndicator` and the primary tint, while a
 * conversation whose work has all finished falls back to the neutral tint Assets
 * uses, so a finished session stays reachable without reading as in-progress.
 * With nothing to show at all the control renders nothing.
 */

import { Activity } from "lucide-react";
import { useCallback, useState } from "react";

import { BottomSheet, Button, Popover, Typography } from "@vellumai/design-library";

import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { useConversationActivity } from "@/domains/chat/hooks/use-conversation-activity";
import { ACP_RUN_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/acp-run";
import { SUBAGENT_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/subagent";
import { InlineProcessCardRow } from "@/domains/chat/process-registry/inline-process-card-row";
import { useIsMobile } from "@/hooks/use-is-mobile";

import type {
  ConversationActivityRow,
  ConversationActivity,
} from "@/domains/chat/hooks/use-conversation-activity";
import type { BackgroundProcessDescriptor } from "@/domains/chat/process-registry/types";

export const ACTIVITY_PILL_TESTID = "conversation-activity-pill";

/**
 * The two kinds this control covers, keyed for row lookup. Workflows and
 * background tools are intentionally absent — they keep their own surfaces.
 */
const DESCRIPTORS: Record<
  ConversationActivityRow["kind"],
  BackgroundProcessDescriptor
> = {
  subagent: SUBAGENT_DESCRIPTOR,
  "acp-run": ACP_RUN_DESCRIPTOR,
};

export interface ConversationActivityPillProps {
  /** Conversation whose sessions are listed. */
  conversationId: string;
}

/** Section heading inside the panel, matching the Assets popover's label. */
function SectionLabel({ children }: { children: string }) {
  return (
    <div className="px-3 pt-3 pb-1">
      <Typography
        variant="label-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {children}
      </Typography>
    </div>
  );
}

/**
 * One session row.
 *
 * `canStop` comes from which group the row is in — its real status in the store
 * — not from the projected card state. `InlineProcessCard` gates its stop button
 * on `summary.state === "loading"`, and a *finished* subagent whose timeline
 * hasn't been fetched yet deliberately projects as `loading` ("Loading", rather
 * than claiming 0 steps — see `use-subagent-card-data`). Passing `onStop` for
 * those rows would put a Stop button on an already-finished session.
 */
function ActivityRow({
  row,
  canStop,
  onClose,
}: {
  row: ConversationActivityRow;
  canStop: boolean;
  onClose: () => void;
}) {
  const descriptor = DESCRIPTORS[row.kind];
  const onStop = canStop && descriptor.onStop ? descriptor.onStop : undefined;
  return (
    <InlineProcessCardRow
      descriptor={descriptor}
      id={row.id}
      testId={`activity-row-${row.id}`}
      onOpen={() => {
        descriptor.onOpenDetail(row.id);
        onClose();
      }}
      onStop={onStop && (() => onStop(row.id))}
    />
  );
}

/** Panel body shared by the popover and the bottom sheet. */
function ActivityPanel({
  activity,
  onClose,
}: {
  activity: ConversationActivity;
  onClose: () => void;
}) {
  const { running, completed } = activity;
  // Headings only earn their space when both groups are present; a list that is
  // all-running or all-finished is already self-describing.
  const showLabels = running.length > 0 && completed.length > 0;
  return (
    <div className="flex min-w-0 flex-col">
      {showLabels ? <SectionLabel>Running</SectionLabel> : null}
      <div className="px-2 pb-1">
        {running.map((row) => (
          <ActivityRow
            key={`${row.kind}:${row.id}`}
            row={row}
            canStop
            onClose={onClose}
          />
        ))}
      </div>
      {showLabels ? <SectionLabel>Recent</SectionLabel> : null}
      <div className="px-2 pb-2">
        {completed.map((row) => (
          <ActivityRow
            key={`${row.kind}:${row.id}`}
            row={row}
            canStop={false}
            onClose={onClose}
          />
        ))}
      </div>
    </div>
  );
}

export function ConversationActivityPill({
  conversationId,
}: ConversationActivityPillProps) {
  const activity = useConversationActivity(conversationId);
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const handleClose = useCallback(() => setOpen(false), []);

  const { running, total } = activity;
  if (total === 0) {
    return null;
  }

  const isRunning = running.length > 0;
  // Running counts the live work; otherwise the total is what's reopenable.
  const count = isRunning ? running.length : total;
  const noun = isRunning ? "running" : count === 1 ? "session" : "sessions";
  const label = `${count} ${noun}`;
  const ariaLabel = isRunning
    ? `Conversation activity, ${count} running`
    : `Conversation activity, ${count} finished`;

  const glyph = isRunning ? (
    <ThreeDotIndicator dotSize={4} gap={2} />
  ) : (
    <Activity />
  );
  const tintColor = isRunning
    ? "var(--primary-base)"
    : "var(--content-default)";

  const panel = <ActivityPanel activity={activity} onClose={handleClose} />;

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>
          <Button
            variant="ghost"
            active
            iconOnly={glyph}
            tintColor={tintColor}
            aria-label={ariaLabel}
            data-testid={ACTIVITY_PILL_TESTID}
          />
        </BottomSheet.Trigger>
        <BottomSheet.Content className="max-h-[85dvh]">
          <BottomSheet.Header>
            <BottomSheet.Title>Activity</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">{panel}</BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          active
          leftIcon={glyph}
          className="rounded-full"
          tintColor={tintColor}
          aria-label={ariaLabel}
          data-testid={ACTIVITY_PILL_TESTID}
        >
          {label}
        </Button>
      </Popover.Trigger>
      {/* `align="end"`, unlike the Assets pill's centred panel: Activity sits
          further right in the cluster, so a centred 320px panel resolves flush
          against the window edge. Anchoring the panel's trailing edge to the
          trigger matches the notification bell, its neighbour on that side. */}
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="max-h-[280px] overflow-y-auto">{panel}</div>
      </Popover.Content>
    </Popover.Root>
  );
}
