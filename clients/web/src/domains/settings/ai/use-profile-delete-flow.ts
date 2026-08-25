import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { isDispatchableProfile } from "@/assistant/profile-pickers";
import { useSupportsCompleteProfileSnapshots } from "@/lib/backwards-compat/complete-profile-snapshots";
import { reassignScheduleInferenceProfile } from "@/domains/settings/api/schedules";
import {
  type BlockedDeleteState,
  movesSchedules,
} from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
import { useProfileActions } from "@/domains/settings/ai/use-profile-actions";
import {
  buildOrderedProfiles,
  type ProfileWithName,
} from "@/domains/settings/ai/utils";
import {
  schedulesGetOptions,
  schedulesGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  CallSiteOverrideDraft,
  ConfigGetResponse,
  ConfigPatchRequestWritable,
} from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { badRequestMessage } from "@/utils/api-errors";

export interface ProfileDeleteFlow {
  /**
   * Delete `name`, or open the reassign dialog when anything still points at
   * the profile: the active selection, a call-site override, or a schedule.
   */
  requestDelete: (name: string) => void;
  /**
   * Profile whose reference scan is in flight, or null. Delete affordances
   * render their in-flight state from this: the scan is a round trip, so
   * without it the action reads as a dead button.
   */
  pendingDeleteName: string | null;
  /** Spread onto a `<BlockedDeleteModal />` render. */
  blockedDeleteModalProps: {
    blocked: BlockedDeleteState | null;
    availableReplacements: ProfileWithName[];
    replacement: string;
    onReplacementChange: (value: string) => void;
    error: string | null;
    saving: boolean;
    onClose: () => void;
    onConfirm: () => void;
  };
}

const PROFILE_SURVIVED_SUFFIX = "The profile was not deleted.";
const SCHEDULE_REASSIGN_ERROR = `Failed to move the schedules. ${PROFILE_SURVIVED_SUFFIX}`;

/**
 * The endpoint's own verdict when it rejected the move, followed by the note
 * that the delete was abandoned. A rejected destination (disabled, unknown)
 * names the thing the user has to change, which a fixed "something failed"
 * string does not, and this dialog is where they would change it.
 */
function scheduleReassignErrorMessage(err: unknown): string {
  const detail = badRequestMessage(err);
  if (!detail) {
    return SCHEDULE_REASSIGN_ERROR;
  }
  const sentence = /[.!?]$/.test(detail) ? detail : `${detail}.`;
  return `${sentence} ${PROFILE_SURVIVED_SUFFIX}`;
}

/**
 * The delete-with-reassign flow shared by the Profiles rows (kebab Delete)
 * and the profile sidepanel (header Delete). Unreferenced profiles delete
 * immediately; referenced ones route through BlockedDeleteModal to pick a
 * replacement first. Deleting the advisor profile clears the advisor
 * reference in the same patch.
 *
 * Schedules carry a concrete profile pin, so deleting a profile is the main
 * way a schedule ends up naming a profile that no longer exists. That is not
 * a failure at run time (the resolver drops a missing pin and falls through
 * to the call site's own selection), but it silently discards a model choice
 * the user made, so the scan surfaces the affected schedules by name and
 * moves them onto the replacement before the delete lands.
 *
 * One replacement covers every reference. Everything being reassigned was
 * already pointing at the same profile, so a single target preserves the
 * grouping the user actually expressed; asking for a separate schedule target
 * would invent a distinction they never made.
 */
export function useProfileDeleteFlow(
  assistantId: string,
  config: ConfigGetResponse | undefined,
  options?: { onDeleted?: (name: string) => void },
): ProfileDeleteFlow {
  const actions = useProfileActions(assistantId);
  const queryClient = useQueryClient();
  // Older assistants live-inherit blank profile fields at resolution time,
  // so a sparse profile is a valid reassignment target there.
  const requireOwnProviderAndModel = useSupportsCompleteProfileSnapshots();

  const activeProfile = config?.llm?.activeProfile ?? null;
  const advisorProfile = config?.llm?.advisorProfile ?? null;
  const callSites = config?.llm?.callSites ?? {};
  const profiles = useMemo(
    () => config?.llm?.profiles ?? {},
    [config?.llm?.profiles],
  );
  const profileOrder = useMemo(
    () => config?.llm?.profileOrder ?? [],
    [config?.llm?.profileOrder],
  );
  const orderedProfiles = useMemo(
    () => buildOrderedProfiles(profiles, profileOrder),
    [profiles, profileOrder],
  );

  const [blocked, setBlocked] = useState<BlockedDeleteState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingDeleteName, setPendingDeleteName] = useState<string | null>(
    null,
  );
  // Mirrors `pendingDeleteName` for the re-entrancy check only. A second click
  // in the same tick would still read the pre-render state value, so the guard
  // reads the ref and the UI reads the state.
  const scanning = useRef(false);

  /**
   * Profiles offered as the replacement target.
   *
   * Reassignment rewrites live references, so a replacement the resolver
   * would skip leaves every call site and schedule it touched silently
   * resolving elsewhere. Incomplete profiles — active, but carrying no
   * provider and model of their own — are the case the user cannot see for
   * themselves, so they are filtered out here via `isDispatchableProfile`,
   * the same predicate the pickers use.
   *
   * Disabled profiles are the one exception the predicate would also drop:
   * they stay on the list so a user who disabled their intended target can
   * still pick it, and the modal marks them unselectable when schedules are
   * moving, since the reassign endpoint refuses a disabled destination.
   * Being told why the obvious target is unavailable beats it silently
   * missing.
   *
   * Everything that survives is offered, managed profiles included: any
   * usable profile is a legal destination, and hiding the managed ones
   * would leave a user whose only other profiles are managed staring at a
   * list missing the target they want. Preference between them is a
   * preselection concern, handled in `defaultReplacementFor`.
   */
  function replacementCandidates(deleting: string | null): ProfileWithName[] {
    return orderedProfiles.filter((p) => {
      if (p.name === deleting) {
        return false;
      }
      if (p.status === "disabled") {
        return true;
      }
      return isDispatchableProfile(p, orderedProfiles, {
        requireOwnProviderAndModel,
      });
    });
  }

  /**
   * Preselected replacement. When schedules are moving, a disabled profile is
   * not a legal destination, so preselecting one would arm the confirm button
   * with a target the server rejects.
   *
   * The current default wins: it is where a schedule carrying no pin of its
   * own would run. When the current default is what is being deleted, the
   * user's own profiles are preferred over managed ones, which are a poor
   * guess at where someone who built their own profiles wants work to land.
   */
  function defaultReplacementFor(
    deleting: string,
    excludeDisabled: boolean,
  ): string {
    const candidates = replacementCandidates(deleting).filter(
      (p) => !excludeDisabled || p.status !== "disabled",
    );
    const current = candidates.find((p) => p.name === activeProfile);
    const own = candidates.find((p) => p.source !== "managed");
    return (current ?? own ?? candidates[0])?.name ?? "";
  }

  async function deleteNow(name: string) {
    try {
      await actions.deleteProfile(name, profileOrder, {
        isAdvisor: name === advisorProfile,
      });
      options?.onDeleted?.(name);
    } catch {
      // Surfaced via toast in useProfileActions.
    }
  }

  async function scanAndOpen(name: string) {
    const entry = profiles[name];
    const label = entry?.label ?? name;
    const isActive = name === activeProfile;
    const blockedCallSiteIds = Object.entries(callSites)
      .filter(([id, v]) => id !== "mainAgent" && v?.profile === name)
      .map(([id]) => id);

    let scheduleNames: string[] = [];
    let deferredReminderCount = 0;
    let scheduleLookupFailed = false;
    try {
      const data = await queryClient.fetchQuery({
        ...schedulesGetOptions({
          path: { assistant_id: assistantId },
          // include_all so the count the user is shown is the count the
          // reassign actually moves: deferred reminders are hidden from the
          // list by default but are moved like any other row.
          query: { inference_profile: name, include_all: "true" },
        }),
        retry: false,
        staleTime: 0,
      });
      const rows = data.schedules ?? [];
      // Deferred reminders all carry the same generated name, so they are
      // counted rather than listed; the user's own schedules are named.
      scheduleNames = rows.filter((s) => !s.isDeferred).map((s) => s.name);
      deferredReminderCount = rows.filter((s) => s.isDeferred).length;
    } catch (err) {
      // An unknown schedule list is not a reason to delete blind: fall
      // through to the dialog so the user is told the check did not complete
      // and the reassign still runs against whatever is pinned.
      captureError(err, {
        context: "settings-ai-profile-delete-schedule-scan",
      });
      scheduleLookupFailed = true;
    }

    const hasReferences =
      isActive ||
      blockedCallSiteIds.length > 0 ||
      scheduleNames.length > 0 ||
      deferredReminderCount > 0;
    if (!hasReferences && !scheduleLookupFailed) {
      await deleteNow(name);
      return;
    }

    const nextBlocked: BlockedDeleteState = {
      name,
      label,
      isActive,
      callSiteIds: blockedCallSiteIds,
      scheduleNames,
      deferredReminderCount,
      scheduleLookupFailed,
    };
    setBlocked(nextBlocked);
    setReplacement(defaultReplacementFor(name, movesSchedules(nextBlocked)));
    setError(null);
  }

  function requestDelete(name: string) {
    // Without config the reference scan below would see no active selection
    // and no call sites, and the delete patch would write an empty
    // profileOrder - refuse instead. Callers gate their delete affordances
    // on config presence, so this is a defensive backstop.
    if (config == null || scanning.current) {
      return;
    }
    scanning.current = true;
    setPendingDeleteName(name);
    void scanAndOpen(name).finally(() => {
      scanning.current = false;
      setPendingDeleteName(null);
    });
  }

  async function handleReassignAndDelete() {
    if (!blocked || !replacement) {
      return;
    }
    setSaving(true);
    setError(null);

    // Schedules move first so the profile is never gone while a schedule still
    // names it. A failed scan also runs this, since the reassign is a no-op
    // when nothing is pinned and the alternative is deleting blind.
    if (movesSchedules(blocked)) {
      try {
        await reassignScheduleInferenceProfile(
          assistantId,
          blocked.name,
          replacement,
        );
        await queryClient.invalidateQueries({
          queryKey: schedulesGetQueryKey({
            path: { assistant_id: assistantId },
          }),
        });
      } catch (err) {
        captureError(err, {
          context: "settings-ai-profile-reassign-schedules",
        });
        setError(scheduleReassignErrorMessage(err));
        setSaving(false);
        return;
      }
    }

    const llmPatch: NonNullable<ConfigPatchRequestWritable["llm"]> = {};
    if (blocked.isActive) {
      llmPatch.activeProfile = replacement;
    }
    if (blocked.callSiteIds.length > 0) {
      const callSitePatch: Record<string, CallSiteOverrideDraft | null> = {};
      for (const id of blocked.callSiteIds) {
        callSitePatch[id] = { profile: replacement };
      }
      llmPatch.callSites = callSitePatch;
    }

    if (Object.keys(llmPatch).length > 0) {
      try {
        await actions.patchLlm(
          llmPatch,
          "settings-ai-profile-reassign-delete",
          "Failed to reassign references. Please try again.",
        );
      } catch {
        setError("Failed to reassign references. Please try again.");
        setSaving(false);
        return;
      }
    }

    const nameToDelete = blocked.name;
    setBlocked(null);
    setSaving(false);
    void deleteNow(nameToDelete);
  }

  return {
    requestDelete,
    pendingDeleteName,
    blockedDeleteModalProps: {
      blocked,
      availableReplacements: replacementCandidates(blocked?.name ?? null),
      replacement,
      onReplacementChange: setReplacement,
      error,
      saving,
      onClose: () => {
        setBlocked(null);
        setError(null);
      },
      onConfirm: () => void handleReassignAndDelete(),
    },
  };
}
