import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { isDispatchableProfile } from "@/assistant/profile-pickers";
import { useSupportsCompleteProfileSnapshots } from "@/lib/backwards-compat/complete-profile-snapshots";
import { reassignScheduleInferenceProfile } from "@/domains/settings/api/schedules";
import type { BlockedDeleteState } from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
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
  ConfigPatchRequest,
} from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";

export interface ProfileDeleteFlow {
  /**
   * Delete `name`, or open the reassign dialog when anything still points at
   * the profile: the active selection, a call-site override, or a schedule.
   */
  requestDelete: (name: string) => void;
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

const SCHEDULE_REASSIGN_ERROR =
  "Failed to move the schedules. The profile was not deleted.";

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
  // Nothing renders from this, and a second click must see it within the same
  // tick, so it is a ref rather than state.
  const scanning = useRef(false);

  /**
   * Profiles offered as the replacement target.
   *
   * Reassignment rewrites live references, so a replacement the resolver
   * would skip leaves every call site and schedule it touched silently
   * resolving elsewhere. Candidates are filtered the same way the pickers
   * are, via `isDispatchableProfile`.
   *
   * Among what survives that filter, managed profiles are a poor default
   * when the user has profiles of their own, but the current default is
   * always offered: it is the preselection, and it is where a schedule
   * carrying no pin of its own would run.
   */
  function replacementCandidates(deleting: string | null): ProfileWithName[] {
    const candidates = orderedProfiles.filter(
      (p) =>
        p.name !== deleting &&
        isDispatchableProfile(p, orderedProfiles, {
          requireOwnProviderAndModel,
        }),
    );
    const preferred = candidates.filter(
      (p) => p.source !== "managed" || p.name === activeProfile,
    );
    return preferred.length > 0 ? preferred : candidates;
  }

  function defaultReplacementFor(deleting: string): string {
    const candidates = replacementCandidates(deleting);
    const current = candidates.find((p) => p.name === activeProfile);
    return (current ?? candidates[0])?.name ?? "";
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
    let scheduleLookupFailed = false;
    try {
      const data = await queryClient.fetchQuery({
        ...schedulesGetOptions({
          path: { assistant_id: assistantId },
          query: { inference_profile: name },
        }),
        retry: false,
        staleTime: 0,
      });
      scheduleNames = (data.schedules ?? []).map((s) => s.name);
    } catch (err) {
      // An unknown schedule list is not a reason to delete blind: fall through
      // to the dialog so the user is told the check did not complete and the
      // reassign still runs against whatever is pinned.
      captureError(err, { context: "settings-ai-profile-delete-schedule-scan" });
      scheduleLookupFailed = true;
    }

    const hasReferences =
      isActive || blockedCallSiteIds.length > 0 || scheduleNames.length > 0;
    if (!hasReferences && !scheduleLookupFailed) {
      await deleteNow(name);
      return;
    }

    setBlocked({
      name,
      label,
      isActive,
      callSiteIds: blockedCallSiteIds,
      scheduleNames,
      scheduleLookupFailed,
    });
    setReplacement(defaultReplacementFor(name));
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
    void scanAndOpen(name).finally(() => {
      scanning.current = false;
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
    if (blocked.scheduleNames.length > 0 || blocked.scheduleLookupFailed) {
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
        setError(SCHEDULE_REASSIGN_ERROR);
        setSaving(false);
        return;
      }
    }

    const llmPatch: NonNullable<ConfigPatchRequest["llm"]> = {};
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
