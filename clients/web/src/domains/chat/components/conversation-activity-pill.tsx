/**
 * Header control listing the current conversation's agent sessions (its
 * subagents and ACP runs), running or finished, so a session's details stay one
 * click away once its transcript card has scrolled out of view.
 *
 * A navigation surface only. Rows open the same read-only detail viewer the
 * transcript card opens, via `onOpenDetail`; nothing here starts, resumes, or
 * restarts an agent. The one action on a live process is Stop, offered on
 * running rows.
 *
 * Deliberately a sibling of {@link ConversationAssetsPill} rather than a section
 * inside it, and built from the same parts: the same ghost/`active` pill
 * trigger, the same desktop-popover / mobile-bottom-sheet split, and (for the
 * rows) the process registry's own `InlineProcessCardRow`, descriptors, and
 * `onOpenDetail` routing. Nothing here is a new visual primitive.
 *
 * The trigger keeps the retired sticky overlay's stacked agent chips (a
 * subagent's avatar, an ACP run's brand mark), so you can see *who* is working
 * without opening anything. Because this control outlives the work (unlike the
 * overlay, which only existed while something ran), the chips are split into two
 * status groups: a pulsing `ThreeDotIndicator` ahead of the running agents, and
 * the same green check the inline cards use ahead of the finished ones. Either
 * group is omitted when empty, and with nothing at all the control renders
 * nothing.
 */

import { CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { BottomSheet, Button, Popover, Typography } from "@vellumai/design-library";

import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { useConversationActivity } from "@/domains/chat/hooks/use-conversation-activity";
import { ACP_RUN_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/acp-run";
import { SUBAGENT_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/subagent";
import { InlineProcessCardRow } from "@/domains/chat/process-registry/inline-process-card-row";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTouchMobile } from "@/hooks/use-touch-mobile";

import type {
  ConversationActivityRow,
  ConversationActivity,
} from "@/domains/chat/hooks/use-conversation-activity";
import type { BackgroundProcessDescriptor } from "@/domains/chat/process-registry/types";

export const ACTIVITY_PILL_TESTID = "conversation-activity-pill";
export const RUNNING_GROUP_TESTID = "activity-trigger-running";
export const COMPLETED_GROUP_TESTID = "activity-trigger-completed";

/**
 * The two kinds this control covers, keyed for row lookup. Workflows and
 * background tools are intentionally absent. They keep their own surfaces.
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

/**
 * Visible chips per status group before the rest collapse into `+N`. Lower than
 * the overlay's {@link MAX_VISIBLE_STACKED_CHIPS} because the trigger can carry
 * two groups at once and shares the header row with the title, Assets, and the
 * notification bell. Six chips per group would crowd all of them out.
 */
const MAX_CHIPS_PER_GROUP = 3;

/** The stacked chip a row contributes, from its own descriptor. */
function rowChip(row: ConversationActivityRow): ReactNode {
  const { pill } = DESCRIPTORS[row.kind];
  // Both covered kinds are `stacked`; the guard is for the type, and degrades to
  // no chip rather than throwing if a kind ever switches to a count pill.
  return pill.variant === "stacked" ? pill.renderChip(row.id) : null;
}

/**
 * One status group in the trigger: a status glyph followed by that group's
 * overlapping agent chips, capped with a `+N` remainder. Renders nothing when
 * the group is empty, so a conversation with only finished work shows only the
 * check group and vice versa.
 */
function TriggerGroup({
  rows,
  glyph,
  max,
  testId,
}: {
  rows: ConversationActivityRow[];
  glyph: ReactNode;
  max: number;
  testId: string;
}) {
  if (rows.length === 0) {
    return null;
  }
  const overflow = rows.length - max;
  return (
    <span data-testid={testId} className="inline-flex items-center gap-1">
      {glyph}
      <span className="flex items-center">
        {rows.slice(0, max).map(rowChip)}
      </span>
      {overflow > 0 ? (
        <Typography
          variant="body-small-default"
          className="text-[var(--content-emphasised)]"
        >
          +{overflow}
        </Typography>
      ) : null}
    </span>
  );
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
 * `canStop` comes from which group the row is in, its real status in the store,
 * not from the projected card state. `InlineProcessCard` gates its stop button
 * on `summary.state === "loading"`, and a *finished* subagent whose timeline
 * hasn't been fetched yet deliberately projects as `loading` ("Loading", rather
 * than claiming 0 steps, see `use-subagent-card-data`). Passing `onStop` for
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
  const isTouchMobile = useTouchMobile();
  const handleClose = useCallback(() => setOpen(false), []);

  const { running, completed, total } = activity;
  if (total === 0) {
    return null;
  }

  const isRunning = running.length > 0;
  // Both counts are named, since the chips alone don't say which group is which
  // to a screen reader.
  const ariaLabel = [
    "Conversation activity",
    running.length > 0 ? `${running.length} running` : null,
    completed.length > 0 ? `${completed.length} finished` : null,
  ]
    .filter(Boolean)
    .join(", ");

  // One chip fewer per group on phones: the header there also carries the
  // title, search, Assets and the bell in a much narrower row.
  const maxChips = isMobile ? 2 : MAX_CHIPS_PER_GROUP;

  const chips = (
    <span className="pointer-events-none inline-flex items-center gap-2">
      <TriggerGroup
        rows={running}
        max={maxChips}
        testId={RUNNING_GROUP_TESTID}
        glyph={<ThreeDotIndicator dotSize={4} gap={2} />}
      />
      <TriggerGroup
        rows={completed}
        max={maxChips}
        testId={COMPLETED_GROUP_TESTID}
        glyph={
          <CheckCircle2
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-[var(--system-positive-strong)]"
          />
        }
      />
      {/* Carried over from the overlay's stacked pill: without it a row of
          avatars doesn't read as something you can open. */}
      {open ? (
        <ChevronUp
          aria-hidden
          className="h-3 w-3 shrink-0 text-[var(--content-tertiary)]"
        />
      ) : (
        <ChevronDown
          aria-hidden
          className="h-3 w-3 shrink-0 text-[var(--content-tertiary)]"
        />
      )}
    </span>
  );

  // Tint drives the label/chevron colour only; the chips carry their own.
  // Primary while live, neutral once everything has settled. The same
  // treatment Assets uses, so finished work stays reachable without reading as
  // in-progress.
  const tintColor = isRunning
    ? "var(--primary-base)"
    : "var(--content-default)";

  const panel = <ActivityPanel activity={activity} onClose={handleClose} />;

  if (isTouchMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>
          {/* Not `iconOnly`: the chips are the content, and a square icon slot
              would clip a stack of them. `size="compact"` + `rounded-full`
              keeps it to a pill the width of its chips. */}
          <Button
            variant="ghost"
            active
            size="compact"
            className="rounded-full"
            tintColor={tintColor}
            aria-label={ariaLabel}
            data-testid={ACTIVITY_PILL_TESTID}
          >
            {chips}
          </Button>
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
          className="rounded-full"
          tintColor={tintColor}
          aria-label={ariaLabel}
          data-testid={ACTIVITY_PILL_TESTID}
        >
          {chips}
        </Button>
      </Popover.Trigger>
      {/* `align="end"`, unlike the Assets pill's centred panel: Activity sits
          further right in the cluster, so a centred panel resolves flush
          against the window edge. Anchoring the panel's trailing edge to the
          trigger matches the notification bell, its neighbour on that side,
          whose 384px width the rows here borrow too: a generated process name
          plus its status metadata needs the room, and `max-w` still yields to
          a narrow viewport. */}
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-96 max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="max-h-[280px] overflow-y-auto">{panel}</div>
      </Popover.Content>
    </Popover.Root>
  );
}
