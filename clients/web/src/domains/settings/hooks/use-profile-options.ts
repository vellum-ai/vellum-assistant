import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  type ProfilePickerIssue,
  profilePickerIssue,
  profilePickerLabel,
  undispatchableProfileReason,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { buildOrderedProfiles } from "@/domains/settings/ai/utils";
import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type LlmConfig = ConfigGetResponse["llm"];

export interface ProfileOption {
  readonly value: string | null;
  readonly label: string;
  /** Set when the resolver would skip this profile; the view renders it. */
  readonly issue?: ProfilePickerIssue;
  /** Hover copy for an `"undispatchable"` option. */
  readonly reason?: string;
}

export function buildProfileOptions(
  llm: LlmConfig | undefined,
  selectedProfile?: string | null,
): ProfileOption[] {
  const profiles = llm?.profiles ?? {};
  const profileOrder = llm?.profileOrder ?? [];
  const orderedProfiles = buildOrderedProfiles(profiles, profileOrder);
  const visibleProfiles = visibleProfilesForPicker(orderedProfiles, [
    selectedProfile,
  ]);

  return [
    { value: null, label: "Default" },
    ...visibleProfiles.map((profile) => {
      const issue = profilePickerIssue(profile, orderedProfiles);
      return {
        value: profile.name,
        label: profilePickerLabel(profile),
        ...(issue ? { issue } : {}),
        ...(issue === "undispatchable"
          ? { reason: undispatchableProfileReason(profile) }
          : {}),
      };
    }),
  ];
}

export function useProfileOptions(
  assistantId: string,
  selectedProfile?: string | null,
): ProfileOption[] {
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });

  return useMemo(
    () => buildProfileOptions(daemonConfig?.llm, selectedProfile),
    [daemonConfig?.llm, selectedProfile],
  );
}
