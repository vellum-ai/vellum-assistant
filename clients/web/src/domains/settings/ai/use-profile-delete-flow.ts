import { useMemo, useState } from "react";

import type { BlockedDeleteState } from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
import { useProfileActions } from "@/domains/settings/ai/use-profile-actions";
import {
  buildOrderedProfiles,
  type ProfileWithName,
} from "@/domains/settings/ai/utils";
import type {
  CallSiteOverrideDraft,
  ConfigGetResponse,
  ConfigPatchRequest,
} from "@/generated/daemon/types.gen";

export interface ProfileDeleteFlow {
  /**
   * Delete `name`, or open the reassign dialog when the profile is still
   * the active selection or referenced by a call site.
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

/**
 * The delete-with-reassign flow shared by the Profiles rows (kebab Delete)
 * and the profile sidepanel (header Delete). Unreferenced profiles delete
 * immediately; referenced ones route through BlockedDeleteModal to pick a
 * replacement first. Deleting the advisor profile clears the advisor
 * reference in the same patch.
 */
export function useProfileDeleteFlow(
  assistantId: string,
  config: ConfigGetResponse | undefined,
  options?: { onDeleted?: (name: string) => void },
): ProfileDeleteFlow {
  const actions = useProfileActions(assistantId);

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

  function requestDelete(name: string) {
    // Without config the reference scan below would see no active selection
    // and no call sites, and the delete patch would write an empty
    // profileOrder - refuse instead. Callers gate their delete affordances
    // on config presence, so this is a defensive backstop.
    if (config == null) {
      return;
    }
    const entry = profiles[name];
    const label = entry?.label ?? name;
    const isActive = name === activeProfile;
    const blockedCallSiteIds = Object.entries(callSites)
      .filter(([id, v]) => id !== "mainAgent" && v?.profile === name)
      .map(([id]) => id);

    if (isActive || blockedCallSiteIds.length > 0) {
      setBlocked({ name, label, isActive, callSiteIds: blockedCallSiteIds });
      setReplacement("");
      setError(null);
      return;
    }
    void deleteNow(name);
  }

  async function handleReassignAndDelete() {
    if (!blocked || !replacement) {
      return;
    }
    setSaving(true);
    setError(null);

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

  // Prefer non-managed profiles as replacement targets.
  const userReplacements = orderedProfiles.filter(
    (p) => p.name !== blocked?.name && p.source !== "managed",
  );
  const availableReplacements =
    userReplacements.length > 0
      ? userReplacements
      : orderedProfiles.filter((p) => p.name !== blocked?.name);

  return {
    requestDelete,
    blockedDeleteModalProps: {
      blocked,
      availableReplacements,
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
