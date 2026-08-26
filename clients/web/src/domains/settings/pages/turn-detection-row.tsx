/**
 * The turn-taking row that hands the end-of-turn decision to the speech model.
 *
 * Every other control in this card tunes the local silence detector: how long
 * a pause runs before the assistant answers, how eagerly it yields. This one
 * decides who makes that call at all. A model that detects turns natively ends
 * the turn from the speech itself rather than from a timer, so the pause
 * setting stops being the thing that governs it.
 *
 * Written as `services.stt.roles.liveVoice`, scoped to the one consumer.
 * The family that detects turns streams and nothing else, so putting it on
 * `services.stt.provider` would leave file transcription and phone calls with
 * no transcriber at all.
 */

import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  configGetOptions,
  configGetQueryKey,
  sttProvidersGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch } from "@/generated/daemon/sdk.gen";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

/** The model family whose transcripts carry their own turn boundaries. */
const TURN_DETECTING_FAMILY = "flux";

/**
 * Whether a provider is served by the platform connection rather than a key of
 * the user's own. Managed live voice is the path that defaults to the
 * turn-detecting family, so it is the one whose unset state reads as on.
 */
function isManagedProvider(provider: string): boolean {
  return provider === "vellum";
}

/**
 * Languages that family serves. Outside them the relay refuses the dial, so
 * turning this on would leave the microphone dead rather than less precise.
 * Kept in step with `fluxSupportedLanguages` in the relay and
 * `FLUX_MULTILINGUAL_SUBTAGS` in the daemon.
 */
const TURN_DETECTING_LANGUAGES = new Set([
  "de",
  "en",
  "es",
  "fr",
  "hi",
  "it",
  "ja",
  "nl",
  "pt",
  "ru",
]);

/** Whether the configured language has a model in that family. */
export function languageSupportsTurnDetection(
  language: string | undefined,
): boolean {
  const normalized = language?.trim().toLowerCase();
  if (!normalized || normalized === "multi") {
    return true;
  }
  return TURN_DETECTING_LANGUAGES.has(normalized.split("-")[0] ?? normalized);
}

interface SttShape {
  provider?: string;
  providers?: Record<string, { model?: string } | undefined>;
  roles?: Record<string, { provider?: string; model?: string } | undefined>;
  language?: string;
}

export function TurnDetectionRow() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();
  const assistantId = useActiveAssistantId();
  const [saving, setSaving] = useState(false);

  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });
  const stt = daemonConfig?.services?.stt as SttShape | undefined;

  const { data: catalog } = useQuery({
    ...sttProvidersGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 5 * 60_000,
  });

  const provider = stt?.roles?.liveVoice?.provider ?? stt?.provider;
  const catalogEntry = catalog?.providers?.find(
    (entry) => entry.id === provider,
  );
  // A provider with no such family has nothing to offer here, so the row is
  // absent rather than present and permanently off.
  const offersTurnDetection =
    catalogEntry?.modelFamilies?.includes(TURN_DETECTING_FAMILY) ?? false;
  if (!provider || !offersTurnDetection) {
    return null;
  }

  const languageOk = languageSupportsTurnDetection(stt?.language);
  // Managed live voice resolves to the turn-detecting family when nothing is
  // named, so an unset selection reads as on rather than off. Without that the
  // row would report a state the session does not run.
  const named =
    stt?.roles?.liveVoice?.model ?? stt?.providers?.[provider]?.model;
  const checked =
    named === undefined
      ? isManagedProvider(provider) && languageOk
      : named === TURN_DETECTING_FAMILY;

  const apply = async (next: boolean) => {
    setSaving(true);
    try {
      const { response } = await configPatch({
        path: { assistant_id: assistantId },
        // `null` deletes the key through the daemon's deep-merge, returning
        // live voice to whatever the global provider is. Writing the global's
        // current value instead would pin it and stop it following a later
        // change.
        body: {
          services: {
            stt: {
              roles: {
                liveVoice: {
                  provider,
                  // Off names the base family rather than deleting the key.
                  // Managed live voice resolves an unnamed family to the
                  // turn-detecting one, so clearing it would switch straight
                  // back on and the toggle would not stick.
                  model: next
                    ? TURN_DETECTING_FAMILY
                    : catalogEntry?.baseModelFamily,
                },
              },
            },
          },
        },
        throwOnError: false,
      });
      if (!response?.ok) {
        throw new Error(String(response?.status ?? ""));
      }
      await queryClient.invalidateQueries({
        queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
      });
    } catch {
      toast.error(t("voicePage.turnDetectionFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-body-medium-lighter text-[var(--content-default)]">
        {t("voicePage.turnDetectionLabel")}
      </span>
      <p className="text-body-small-default text-[var(--content-tertiary)]">
        {languageOk
          ? t("voicePage.turnDetectionDescription")
          : t("voicePage.turnDetectionLanguageUnsupported")}
      </p>
      <Toggle
        checked={checked}
        disabled={saving || !languageOk}
        onChange={(next) => void apply(next)}
        aria-label={t("voicePage.turnDetectionLabel")}
      />
    </div>
  );
}
