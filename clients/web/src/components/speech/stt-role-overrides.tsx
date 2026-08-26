/**
 * The consumers running an STT provider other than `services.stt.provider`.
 *
 * `services.stt.roles` lets one consumer diverge from the global provider,
 * and managed-speech defaulting can write one without the user asking (live
 * voice moves to Flux while batch and telephony stay behind). The provider
 * form above shows only the global, so without this the divergence that
 * config exists to make visible would be legible only in the daemon log.
 *
 * Read-only compatibility: an assistant predating `services.stt.roles` omits
 * the field, so `entries` is empty and the section does not render, which is
 * exactly the feature-off state. The reset write is reachable only from a row,
 * and a row exists only where a daemon wrote a role, so it cannot reach an
 * assistant that would not understand it. That structural gate is why there is
 * no `MIN_VERSION` here: a version gate would have to name an unreleased
 * version, which reads as unsupported on same-source self-hosted daemons that
 * report the last released version while running this code.
 */

import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  configGetOptions,
  configGetQueryKey,
  sttProvidersGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch } from "@/generated/daemon/sdk.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

/** A `services.stt.roles.<role>` entry: a provider and optional family. */
interface SttRoleSelection {
  provider?: string;
  model?: string;
}

/** The shape this component reads out of the `services.stt` config block. */
export interface SttConfigShape {
  provider?: string;
  providers?: Record<string, { model?: string } | undefined>;
  roles?: Record<string, SttRoleSelection | undefined>;
}

/**
 * The label key for each role, written out per role rather than built from the
 * role id.
 *
 * The catalog guard (`i18n/catalogs.test.ts`) decides a key is dead copy by
 * searching source text for it quoted, so a key assembled from a template
 * literal reads as unreferenced and the five role labels would be deleted as
 * orphans. Writing them out also means a role the daemon adds later renders
 * its raw id instead of a missing-key placeholder.
 */
const ROLE_LABEL_KEYS = {
  batch: "sttRoleOverrides.role.batch",
  dictation: "sttRoleOverrides.role.dictation",
  liveVoice: "sttRoleOverrides.role.liveVoice",
  telephony: "sttRoleOverrides.role.telephony",
  watch: "sttRoleOverrides.role.watch",
} as const;

/** A consumer whose provider differs from the global one. */
export interface SttRoleOverrideEntry {
  role: string;
  provider: string;
  model?: string;
}

/**
 * The roles that resolve to something other than the global selection.
 *
 * Compares the pair, not the provider alone: `{deepgram, flux}` and plain
 * `deepgram` are different transcribers with different capabilities, and a
 * role naming the family the global already uses is not a divergence worth
 * showing.
 */
export function sttRoleOverrideEntries(
  stt: SttConfigShape | undefined,
): SttRoleOverrideEntry[] {
  const roles = stt?.roles;
  if (!roles) {
    return [];
  }
  const globalProvider = stt?.provider;
  const globalModel = globalProvider
    ? stt?.providers?.[globalProvider]?.model
    : undefined;

  const entries: SttRoleOverrideEntry[] = [];
  for (const [role, selection] of Object.entries(roles)) {
    const provider = selection?.provider;
    if (!provider) {
      continue;
    }
    if (provider === globalProvider && selection?.model === globalModel) {
      continue;
    }
    entries.push({
      role,
      provider,
      ...(selection?.model !== undefined ? { model: selection.model } : {}),
    });
  }
  return entries;
}

export function SttRoleOverrides({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();
  const [clearing, setClearing] = useState<string | null>(null);

  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });
  // `services.stt` falls under the ConfigGetResponse index signature
  // (`unknown`), so narrow it explicitly, as the provider form does.
  const stt = daemonConfig?.services?.stt as SttConfigShape | undefined;
  const entries = sttRoleOverrideEntries(stt);

  // Display names for the base providers. Variant rows are filtered out of
  // this endpoint (they are selected through a model family, not offered as
  // providers), so the family is rendered from the role's own pair.
  const { data: catalog } = useQuery({
    ...sttProvidersGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady && entries.length > 0,
    staleTime: 5 * 60_000,
  });

  if (entries.length === 0) {
    return null;
  }

  const displayNameFor = (provider: string): string =>
    catalog?.providers?.find((p) => p.id === provider)?.displayName ?? provider;

  const clearRole = async (role: string) => {
    setClearing(role);
    try {
      const { response } = await configPatch({
        path: { assistant_id: assistantId },
        // `null` deletes the key through the daemon's deep-merge, which is
        // what returns this consumer to the global provider. Writing the
        // global's value instead would pin it, and it would stop following
        // a later change to the global.
        body: { services: { stt: { roles: { [role]: null } } } },
        throwOnError: false,
      });
      if (!response?.ok) {
        throw new Error(String(response?.status ?? ""));
      }
      await queryClient.invalidateQueries({
        queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
      });
    } catch {
      toast.error(t("sttRoleOverrides.clearFailed"));
    } finally {
      setClearing(null);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-[var(--border-subtle)] pt-4">
      <span className="text-body-small-default text-[var(--content-tertiary)]">
        {t("sttRoleOverrides.title")}
      </span>
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => {
          const labelKey =
            ROLE_LABEL_KEYS[entry.role as keyof typeof ROLE_LABEL_KEYS];
          return (
            <li
              key={entry.role}
              className="flex items-center gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-body-medium-lighter text-[var(--content-default)]">
                {labelKey ? t(labelKey) : entry.role}
              </span>
              <span className="min-w-0 truncate text-body-small-default text-[var(--content-default)]">
                {entry.model
                  ? `${displayNameFor(entry.provider)} · ${entry.model}`
                  : displayNameFor(entry.provider)}
              </span>
              <Button
                variant="ghost"
                size="compact"
                // Sibling text does not reach a button's accessible name, so
                // several rows would otherwise offer a screen reader a column
                // of buttons all called "Reset".
                aria-label={t("sttRoleOverrides.clearAria", {
                  feature: labelKey ? t(labelKey) : entry.role,
                })}
                // Ghost resolves to `--content-default`, which reads louder
                // than the provider it sits beside. The value is what the row
                // exists to report; this is only the way out of it.
                className="[--vbtn-fg:var(--content-tertiary)]"
                disabled={clearing === entry.role}
                onClick={() => void clearRole(entry.role)}
              >
                {t("sttRoleOverrides.clear")}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
