import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { buildOrderedProfiles } from "@/domains/settings/ai/utils";
import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { profilePickerLabel } from "@/assistant/profile-pickers";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type LlmConfig = ConfigGetResponse["llm"];

export interface ProfileOption {
  /** Profile key, or `null` for the leading "Default" option that clears an override. */
  readonly value: string | null;
  readonly label: string;
}

/**
 * Builds the ordered option list for an editable inference-profile picker.
 *
 * Respects `llm.profileOrder` (via `buildOrderedProfiles`), drops
 * `status === "disabled"` profiles, maps each label to `profile.label ?? key`,
 * and prepends a `value: null` "Default" option that clears any override.
 *
 * Pure (no React) so it is unit-testable without a render harness.
 */
export function buildProfileOptions(llm: LlmConfig | undefined): ProfileOption[] {
  const profiles = llm?.profiles ?? {};
  const profileOrder = llm?.profileOrder ?? [];

  const options: ProfileOption[] = buildOrderedProfiles(profiles, profileOrder)
    .filter((profile) => profile.status !== "disabled")
    .map((profile) => ({
      value: profile.name,
      label: profilePickerLabel(profile),
    }));

  return [{ value: null, label: "Default" }, ...options];
}

/**
 * Reads daemon config via the shared `configGetOptions()` query and returns an
 * ordered list of `{ value, label }` options for an editable profile picker.
 * See {@link buildProfileOptions} for ordering/filtering semantics.
 */
export function useProfileOptions(assistantId: string): ProfileOption[] {
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });

  return useMemo(
    () => buildProfileOptions(daemonConfig?.llm),
    [daemonConfig?.llm],
  );
}
