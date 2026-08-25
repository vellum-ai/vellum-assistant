import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import { useLlmConfigPatch } from "@/domains/settings/ai/use-llm-config-patch";
import { t } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { inferenceProfilesByNameValidatePost } from "@/generated/daemon/sdk.gen";
import type { ProfilePatchEntry } from "@/generated/daemon/types.gen";

/**
 * Probe the just-saved profile with one minimal request and surface a
 * classified warning toast when it fails, so a wrong model name or a broken
 * provider connection is visible at save time instead of on the first chat
 * message. Advisory and fire-and-forget: a missing route (older daemon) or a
 * transport error must not disturb the save flow, and a null check means the
 * daemon had no verdict to give.
 */
async function probeSavedProfile(
  assistantId: string,
  name: string,
): Promise<void> {
  try {
    const { data } = await inferenceProfilesByNameValidatePost({
      path: { assistant_id: assistantId, name },
    });
    const check = data?.check;
    if (!check || check.ok) {
      return;
    }
    const key =
      check.blame === "profile"
        ? ("settings:profileCheck.profileError" as const)
        : check.blame === "provider"
          ? check.connection
            ? ("settings:profileCheck.providerError" as const)
            : ("settings:profileCheck.providerErrorUnnamed" as const)
          : check.blame === "transient"
            ? ("settings:profileCheck.transient" as const)
            : ("settings:profileCheck.unknown" as const);
    toast.warning(
      t(key, {
        detail: check.detail ?? "",
        connection: check.connection ?? "",
      }),
    );
  } catch {
    // Advisory only.
  }
}

export interface ProfileSave {
  /**
   * Persist a profile entry from the settings surface. Matches the
   * `UseProfileEditorArgs.onSave` contract:
   * - `mode: "merge"` sends one deep-merge PATCH (the view-mode managed
   *   re-enable) so seed-owned fields survive.
   * - `mode: "replace"` (default) writes a clean replacement: creates
   *   append to `profileOrder`; edits run a delete-then-recreate cycle so
   *   omitted advanced params reset to "inherit" instead of deep-merging
   *   into stale values, with a best-effort rollback if the recreate
   *   fails.
   * Fires the settings-surface create success toast, then `onSaved`.
   */
  saveProfile: (
    name: string,
    entry: ProfilePatchEntry,
    options?: { mode?: "merge" | "replace" },
  ) => Promise<void>;
  isPending: boolean;
}

export function useProfileSave(
  assistantId: string,
  { onSaved }: { onSaved?: () => void } = {},
): ProfileSave {
  const configMutation = useLlmConfigPatch(assistantId);

  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const profiles = useMemo(
    () => config?.llm?.profiles ?? {},
    [config?.llm?.profiles],
  );
  const profileOrder = config?.llm?.profileOrder ?? [];

  async function saveProfile(
    name: string,
    entry: ProfilePatchEntry,
    options?: { mode?: "merge" | "replace" },
  ) {
    const saveMode = options?.mode ?? "replace";
    const isNew = !(name in profiles);

    if (saveMode === "merge" && !isNew) {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [name]: entry } } },
      });
      onSaved?.();
      return;
    }

    const llmPatch: {
      profiles: Record<string, ProfilePatchEntry>;
      profileOrder?: string[];
    } = { profiles: { [name]: entry } };
    if (isNew) {
      llmPatch.profileOrder = profileOrder.includes(name)
        ? profileOrder
        : [...profileOrder, name];
    }

    if (!isNew) {
      const oldEntry = profiles[name];
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: { profiles: { [name]: null } } },
      });
      try {
        await configMutation.mutateAsync({
          path: { assistant_id: assistantId },
          body: { llm: llmPatch },
        });
      } catch (recreateErr) {
        captureError(recreateErr, {
          context: "settings-ai-profile-edit-recreate",
        });
        // Best-effort rollback: restore old entry so the profile isn't lost
        if (oldEntry != null) {
          await configMutation
            .mutateAsync({
              path: { assistant_id: assistantId },
              body: { llm: { profiles: { [name]: oldEntry } } },
            })
            .catch(() => {
              /* rollback failed - original error still propagates */
            });
        }
        throw recreateErr;
      }
    } else {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: llmPatch },
      });
    }

    if (isNew) {
      toast.success(
        t("settings:useProfileSave.createdToast", {
          name: entry.label ?? name,
        }),
      );
    }
    onSaved?.();
    void probeSavedProfile(assistantId, name);
  }

  return { saveProfile, isPending: configMutation.isPending };
}
