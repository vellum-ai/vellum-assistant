import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  profilePickerLabel,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { buildOrderedProfiles } from "@/domains/settings/ai/utils";
import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type LlmConfig = ConfigGetResponse["llm"];

export interface ProfileOption {
  readonly value: string | null;
  readonly label: string;
}

export function buildProfileOptions(
  llm: LlmConfig | undefined,
  selectedProfile?: string | null,
): ProfileOption[] {
  const profiles = llm?.profiles ?? {};
  const profileOrder = llm?.profileOrder ?? [];
  const visibleProfiles = visibleProfilesForPicker(
    buildOrderedProfiles(profiles, profileOrder),
    [selectedProfile],
  );

  return [
    { value: null, label: "Default" },
    ...visibleProfiles.map((profile) => ({
      value: profile.name,
      label: profilePickerLabel(profile),
    })),
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
