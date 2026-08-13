import { Button } from "@vellumai/design-library/components/button";
import { Select } from "@vellumai/design-library/components/select";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

import { profilePickerLabel } from "@/assistant/profile-pickers";
import type { ProfileWithName } from "@/domains/settings/ai/utils";
import { t, useTranslation } from "@/i18n";

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

function buildSummary(blocked: BlockedDeleteState): string {
  const display = blocked.label || blocked.name;
  const clauses: string[] = [];
  if (blocked.isActive) {
    clauses.push(
      t("settings:manageProfilesBlockedDeleteModal.clauseDefaultProfile"),
    );
  }
  if (blocked.callSiteIds.length > 0) {
    clauses.push(
      t("settings:manageProfilesBlockedDeleteModal.clauseActionOverrides", {
        count: blocked.callSiteIds.length,
      }),
    );
  }
  const scheduleCount = blocked.scheduleNames.length;
  const reminderCount = blocked.deferredReminderCount;
  if (scheduleCount > 0 && reminderCount > 0) {
    clauses.push(
      t("settings:manageProfilesBlockedDeleteModal.clauseRunsBoth", {
        schedules: scheduleCount,
        reminders: reminderCount,
      }),
    );
  } else if (scheduleCount > 0) {
    clauses.push(
      t("settings:manageProfilesBlockedDeleteModal.clauseRunsSchedules", {
        count: scheduleCount,
      }),
    );
  } else if (reminderCount > 0) {
    clauses.push(
      t("settings:manageProfilesBlockedDeleteModal.clauseRunsReminders", {
        count: reminderCount,
      }),
    );
  }
  if (clauses.length === 0) {
    return t("settings:manageProfilesBlockedDeleteModal.summaryNoReferences", {
      display,
    });
  }
  if (clauses.length === 1) {
    return t("settings:manageProfilesBlockedDeleteModal.summaryOneClause", {
      display,
      clause1: clauses[0],
    });
  }
  if (clauses.length === 2) {
    return t("settings:manageProfilesBlockedDeleteModal.summaryTwoClauses", {
      display,
      clause1: clauses[0],
      clause2: clauses[1],
    });
  }
  return t("settings:manageProfilesBlockedDeleteModal.summaryThreeClauses", {
    display,
    clause1: clauses[0],
    clause2: clauses[1],
    clause3: clauses[2],
  });
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
  const { t } = useTranslation("settings");
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
          <Modal.Title>
            {t("manageProfilesBlockedDeleteModal.title")}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          {blocked && (
            <Typography variant="body-medium-default" as="p">
              {buildSummary(blocked)}
            </Typography>
          )}
          {blocked && blocked.callSiteIds.length > 0 && (
            <ReferenceList
              title={t("manageProfilesBlockedDeleteModal.actionOverridesTitle")}
              items={blocked.callSiteIds}
              mono
            />
          )}
          {shownSchedules.length > 0 && (
            <div className="space-y-1">
              <ReferenceList
                title={t("manageProfilesBlockedDeleteModal.schedulesTitle")}
                items={shownSchedules}
              />
              {hiddenScheduleCount > 0 && (
                <Typography
                  variant="body-small-default"
                  as="p"
                  className="pl-1 text-(--content-tertiary)"
                >
                  {t("manageProfilesBlockedDeleteModal.moreSchedules", {
                    count: hiddenScheduleCount,
                  })}
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
              {t("manageProfilesBlockedDeleteModal.scheduleLookupFailed")}
            </Typography>
          )}
          <div className="space-y-1">
            <label className="block text-body-small-default text-(--content-tertiary)">
              {t("manageProfilesBlockedDeleteModal.replacementLabel")}
            </label>
            <Select
              aria-label={t("manageProfilesBlockedDeleteModal.replacementLabel")}
              value={replacement}
              onChange={onReplacementChange}
              placeholder={t(
                "manageProfilesBlockedDeleteModal.replacementPlaceholder",
              )}
              options={availableReplacements.map((p) => {
                const unusable =
                  disabledTargetsBlocked && p.status === "disabled";
                return {
                  value: p.name,
                  label: profilePickerLabel(p),
                  disabled: unusable,
                  tooltip: unusable
                    ? t("manageProfilesBlockedDeleteModal.disabledTargetTooltip")
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
            {t("manageProfilesBlockedDeleteModal.cancel")}
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={!replacement || saving}
            onClick={onConfirm}
          >
            {saving
              ? t("manageProfilesBlockedDeleteModal.saving")
              : t("manageProfilesBlockedDeleteModal.reassignAndDelete")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
