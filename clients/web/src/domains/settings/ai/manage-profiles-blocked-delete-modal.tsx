import { Button } from "@vellumai/design-library/components/button";
import { Select } from "@vellumai/design-library/components/select";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

import { profilePickerLabel } from "@/assistant/profile-pickers";
import type { ProfileWithName } from "@/domains/settings/ai/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlockedDeleteState {
  name: string;
  label: string;
  isActive: boolean;
  callSiteIds: string[];
  /** Names of the user's own schedules pinned to this profile. */
  scheduleNames: string[];
  /**
   * Deferred reminders pinned to this profile. They share one generated name,
   * so they are counted rather than listed, but they move with everything else
   * and so must be counted.
   */
  deferredReminderCount: number;
  /**
   * The schedule lookup did not complete, so `scheduleNames` says nothing
   * about what is pinned. The dialog says so rather than implying a clean
   * delete.
   */
  scheduleLookupFailed: boolean;
}

/**
 * Whether confirming this dialog moves schedules. A failed lookup counts: the
 * reassign runs anyway, because the alternative is deleting blind.
 *
 * The single definition of "the reassign will run", shared by the flow that
 * issues the call and the dialog that has to keep the user off a destination
 * that call would reject.
 */
export function movesSchedules(blocked: BlockedDeleteState): boolean {
  return (
    blocked.scheduleNames.length > 0 ||
    blocked.deferredReminderCount > 0 ||
    blocked.scheduleLookupFailed
  );
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

/** How many schedule names to spell out before summarizing the remainder. */
const SCHEDULE_PREVIEW_LIMIT = 5;

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) {
    return clauses[0]!;
  }
  if (clauses.length === 2) {
    return `${clauses[0]} and ${clauses[1]}`;
  }
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses.at(-1)}`;
}

function buildSummary(blocked: BlockedDeleteState): string {
  const display = blocked.label || blocked.name;
  const uses: string[] = [];
  if (blocked.isActive) {
    uses.push("is your default profile");
  }
  if (blocked.callSiteIds.length > 0) {
    uses.push(
      `is used by ${pluralize(blocked.callSiteIds.length, "action override")}`,
    );
  }
  const runs: string[] = [];
  if (blocked.scheduleNames.length > 0) {
    runs.push(pluralize(blocked.scheduleNames.length, "schedule"));
  }
  if (blocked.deferredReminderCount > 0) {
    runs.push(pluralize(blocked.deferredReminderCount, "reminder"));
  }
  if (runs.length > 0) {
    uses.push(`runs ${joinClauses(runs)}`);
  }
  if (uses.length === 0) {
    return `Choose a replacement profile for "${display}". Anything still pointing at it moves there before it is deleted.`;
  }
  return `"${display}" ${joinClauses(
    uses,
  )}. Pick a replacement below and those references move to it, then "${display}" is deleted.`;
}

// ---------------------------------------------------------------------------
// BlockedDeleteModal
// ---------------------------------------------------------------------------

function ReferenceList({
  title,
  items,
  mono,
}: {
  title: string;
  items: string[];
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Typography
        variant="body-small-default"
        as="p"
        className="text-(--content-tertiary)"
      >
        {title}
      </Typography>
      <ul className="space-y-1 pl-1">
        {items.map((item) => (
          <li
            key={item}
            className="text-body-small-default text-(--content-secondary)"
          >
            • {mono ? <code>{item}</code> : item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BlockedDeleteModal({
  blocked,
  availableReplacements,
  replacement,
  onReplacementChange,
  error,
  saving,
  onClose,
  onConfirm,
}: {
  blocked: BlockedDeleteState | null;
  availableReplacements: ProfileWithName[];
  replacement: string;
  onReplacementChange: (value: string) => void;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const scheduleNames = blocked?.scheduleNames ?? [];
  const shownSchedules = scheduleNames.slice(0, SCHEDULE_PREVIEW_LIMIT);
  const hiddenScheduleCount = scheduleNames.length - shownSchedules.length;
  // A disabled profile cannot run a schedule, and the reassign endpoint says
  // so by rejecting it. Keep it on the list, greyed out, rather than dropping
  // it: a user who disabled their intended target needs to see that it is the
  // reason, not wonder where the profile went.
  const disabledTargetsBlocked = blocked != null && movesSchedules(blocked);

  return (
    <Modal.Root
      open={blocked !== null}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Choose a Replacement Profile</Modal.Title>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          {blocked && (
            <Typography variant="body-medium-default" as="p">
              {buildSummary(blocked)}
            </Typography>
          )}
          {blocked && blocked.callSiteIds.length > 0 && (
            <ReferenceList
              title="Action overrides"
              items={blocked.callSiteIds}
              mono
            />
          )}
          {shownSchedules.length > 0 && (
            <div className="space-y-1">
              <ReferenceList title="Schedules" items={shownSchedules} />
              {hiddenScheduleCount > 0 && (
                <Typography
                  variant="body-small-default"
                  as="p"
                  className="pl-1 text-(--content-tertiary)"
                >
                  and {hiddenScheduleCount} more
                </Typography>
              )}
            </div>
          )}
          {blocked?.scheduleLookupFailed && (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-(--system-mid-strong)"
            >
              We could not check which schedules use this profile. Any schedule
              pinned to it moves to the replacement as well.
            </Typography>
          )}
          <div className="space-y-1">
            <label className="block text-body-small-default text-(--content-tertiary)">
              Replacement profile
            </label>
            <Select
              aria-label="Replacement profile"
              value={replacement}
              onChange={onReplacementChange}
              placeholder="Select a replacement…"
              options={availableReplacements.map((p) => {
                const unusable =
                  disabledTargetsBlocked && p.status === "disabled";
                return {
                  value: p.name,
                  label: profilePickerLabel(p),
                  disabled: unusable,
                  tooltip: unusable
                    ? "Enable this profile to move schedules onto it."
                    : undefined,
                };
              })}
            />
          </div>
          {error && (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-(--system-negative-strong)"
            >
              {error}
            </Typography>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={!replacement || saving}
            onClick={onConfirm}
          >
            {saving ? "Saving…" : "Reassign and Delete"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
