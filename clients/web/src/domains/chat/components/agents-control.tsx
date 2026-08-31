/**
 * The agents control: stacked agent marks that open the list of sessions.
 *
 * One component, two mounts. The floating status cluster shows the whole
 * conversation's agents; the transcript shows the ones a particular turn
 * spawned, where it spawned them. They look and behave identically because they
 * ARE the same control; the only difference is which rows they are handed.
 *
 * The marks are the label: each agent's avatar (or an ACP run's brand mark) is
 * how it identifies itself everywhere else, so the trigger shows who is working
 * and the accessible name carries the counts the marks cannot.
 *
 * Rows inside are the descriptor's own `InlineProcessCardRow`, so a session
 * looks the same here as in every other list of processes.
 */

import { useState } from "react";

import { AdaptivePopover } from "@/domains/chat/components/adaptive-popover";
import {
  ACTIVITY_DESCRIPTORS,
  ConversationActivityChips,
} from "@/domains/chat/components/conversation-activity-chips";
import { InlineProcessCardRow } from "@/domains/chat/process-registry/inline-process-card-row";
import { SideControlButton } from "@/domains/chat/components/side-control-button";
import { useTranslation } from "@/i18n";

import type { ConversationActivity } from "@/domains/chat/hooks/use-conversation-activity";

export interface AgentsControlProps {
  activity: ConversationActivity;
  /**
   * Opens a session's detail. Defaults to the descriptor's own route, which is
   * what the floating cluster wants; the transcript passes its own handler so
   * the click stays on the callbacks that message was rendered with.
   */
  onOpenRow?: (kind: ConversationActivity["running"][number]["kind"], id: string) => void;
  onStopRow?: (kind: ConversationActivity["running"][number]["kind"], id: string) => void;
  "data-testid"?: string;
}

export function AgentsControl({
  activity,
  onOpenRow,
  onStopRow,
  "data-testid": dataTestId = "agents-control",
}: AgentsControlProps) {
  const { t } = useTranslation("chat");
  const { running, completed } = activity;
  // Owned here so opening a row can close the panel. On touch the panel is a
  // modal sheet, and a detail opened behind it is unreachable until the sheet
  // is dismissed by hand.
  const [open, setOpen] = useState(false);

  const label = t("progressRail.agentsToggleAria", {
    running: running.length,
    completed: completed.length,
  });

  const trigger = (
    <SideControlButton
      // Anything still working sweeps the whole pill.
      loading={running.length > 0}
      aria-label={label}
      tooltip={label}
      data-testid={dataTestId}
    >
      <ConversationActivityChips activity={activity} />
    </SideControlButton>
  );

  return (
    <AdaptivePopover
      trigger={trigger}
      title={t("progressRail.agentsLabel")}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="flex flex-col gap-1 p-2">
        {/* Running first, then finished: the order the activity hook reports,
            and the one the rows read best in. */}
        {[...running, ...completed].map((row) => {
          const descriptor = ACTIVITY_DESCRIPTORS[row.kind];
          // Stop is offered on rows classified as RUNNING by the caller, not on
          // whatever the card projection says: a finished subagent whose
          // timeline hasn't been fetched yet still projects as `loading`, and
          // would otherwise get a Stop button for work already over.
          const isRunning = running.some(
            (r) => r.kind === row.kind && r.id === row.id,
          );
          const stop = onStopRow
            ? () => onStopRow(row.kind, row.id)
            : descriptor.onStop
              ? () => descriptor.onStop!(row.id)
              : undefined;
          return (
            <InlineProcessCardRow
              key={`${row.kind}:${row.id}`}
              descriptor={descriptor}
              id={row.id}
              testId={`progress-agent-${row.id}`}
              // The descriptor carries an untranslated fallback; a subagent row
              // has a catalogued label, so use it. ACP rows have none, and fall
              // through to the descriptor's.
              stopAriaLabel={
                row.kind === "subagent"
                  ? t("subagentSpawnGroup.stopSubagentAria")
                  : undefined
              }
              onOpen={() => {
                setOpen(false);
                if (onOpenRow) {
                  onOpenRow(row.kind, row.id);
                } else {
                  descriptor.onOpenDetail(row.id);
                }
              }}
              onStop={isRunning ? stop : undefined}
            />
          );
        })}
      </div>
    </AdaptivePopover>
  );
}
