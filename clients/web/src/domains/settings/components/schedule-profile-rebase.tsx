import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { reassignScheduleInferenceProfile } from "@/domains/settings/api/schedules";
import { canScheduleStillRun } from "@/domains/settings/utils/schedule-formatters";
import { useCallSiteDefaultProfile } from "@/hooks/use-call-site-default-profile";
import { captureError } from "@/lib/sentry/capture-error";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

import type { Schedule } from "@/domains/settings/types/schedules";

export interface ScheduleProfileRebaseDialogProps {
  open: boolean;
  /** Display name of the profile every schedule would move onto. */
  profileLabel: string | null;
  /** How many of the listed schedules run on some other profile today. */
  offDefaultCount: number;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface ScheduleProfileRebase {
  /**
   * Display name of the profile a new schedule would be pinned to right now,
   * or null while the config loads or when no named profile wins.
   */
  defaultProfileLabel: string | null;
  /**
   * How many of the given schedules can still run and are on some other
   * profile. Rows that already fired or were cancelled keep their profile only
   * as history, and the daemon leaves them alone, so counting them here would
   * offer a move that reports back a smaller number than it promised.
   */
  offDefaultCount: number;
  /** Whether to offer the action at all: something has to move. */
  canRebase: boolean;
  requestRebase: () => void;
  dialogProps: ScheduleProfileRebaseDialogProps;
}

/**
 * The "move every schedule onto my current default model" flow.
 *
 * Each schedule is pinned to a concrete profile taken from the default in
 * force when it was created, which is what keeps its cost from moving under
 * the user. The cost of that guarantee is drift: change the default and the
 * schedules made under the old one stay where they were. This is the escape
 * hatch, and it reassigns server-side in one call rather than fanning out a
 * PATCH per row, so the set that moves is the set the daemon sees, including
 * the deferred reminders the list does not show.
 */
export function useScheduleProfileRebase(
  assistantId: string,
  schedules: Schedule[],
  onRebased: () => void,
): ScheduleProfileRebase {
  const defaultProfile = useCallSiteDefaultProfile(assistantId, "mainAgent");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const offDefaultCount = useMemo(() => {
    if (!defaultProfile.key) {
      return 0;
    }
    return schedules.filter(
      (schedule) =>
        canScheduleStillRun(schedule) &&
        schedule.inferenceProfile !== defaultProfile.key,
    ).length;
  }, [defaultProfile.key, schedules]);

  const label = defaultProfile.label;

  const rebase = useMutation({
    mutationFn: (toProfile: string) =>
      reassignScheduleInferenceProfile(assistantId, null, toProfile),
    onSuccess: (moved) => {
      setConfirmOpen(false);
      onRebased();
      toast.success(
        moved === 0
          ? `Every schedule already runs on ${label}.`
          : `Moved ${moved} ${moved === 1 ? "schedule" : "schedules"} to ${label}.`,
      );
    },
    onError: (error) => {
      captureError(error, { context: "schedules_rebase_inference_profile" });
      toast.error("Failed to move the schedules.");
    },
  });

  return {
    defaultProfileLabel: label,
    offDefaultCount,
    canRebase: offDefaultCount > 0,
    requestRebase: () => setConfirmOpen(true),
    dialogProps: {
      open: confirmOpen && defaultProfile.key != null,
      profileLabel: label,
      offDefaultCount,
      isPending: rebase.isPending,
      onConfirm: () => {
        if (defaultProfile.key) {
          rebase.mutate(defaultProfile.key);
        }
      },
      onCancel: () => setConfirmOpen(false),
    },
  };
}

/**
 * Confirmation gate for {@link useScheduleProfileRebase}. The rebase touches
 * every schedule at once, including ones the user deliberately moved off the
 * default, so it never runs without an explicit confirm that names both the
 * destination and the blast radius.
 */
export function ScheduleProfileRebaseDialog({
  open,
  profileLabel,
  offDefaultCount,
  isPending,
  onConfirm,
  onCancel,
}: ScheduleProfileRebaseDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title={`Use ${profileLabel} for every schedule?`}
      message={`${offDefaultCount} of the schedules below ${
        offDefaultCount === 1 ? "runs" : "run"
      } on a different model. This moves every schedule, including reminders your assistant set aside for later, onto ${profileLabel}, your current default. Schedules you deliberately put on another model move too.`}
      confirmLabel="Move schedules"
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
