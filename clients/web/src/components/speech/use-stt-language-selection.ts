/**
 * Spoken-language selection for the speech-to-text surfaces (the settings
 * form, the voice first-run card, and the voice-room gear popover, hence
 * `components/speech/` rather than any one domain). Reads the current
 * language from daemon config and writes the chosen one back; the source of
 * truth is `services.stt.language`, never a client store (server data has
 * one owner).
 *
 * **Hot-apply:** the daemon resolves its STT language from config fresh on
 * every spoken turn, and `config_patch` invalidates the config cache. So a
 * pick here takes effect from the user's next utterance in the same session,
 * with no session runtime message and independent of the form's Save button.
 *
 * Only offered when the daemon reports the configured provider as manually
 * language-selectable (`languageSelection: "manual"` on the provider probe).
 * Providers that auto-detect (Gemini, Whisper) and old daemons that omit the
 * field read as unavailable, so the surfaces render no control rather than
 * pretending to save a language the daemon would ignore.
 */

import { useQuery } from "@tanstack/react-query";

import {
  configGetOptions,
  sttProvidersGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS,
  STT_LANGUAGE_DEFAULT_CODE,
} from "@/lib/stt/language-catalog";

import { useSerializedConfigSelection } from "@/components/speech/use-serialized-config-selection";

/**
 * The code written when the user picks the default option. The daemon cannot
 * delete `services.stt.language`: `config_patch` deep-merges, and a `null`
 * leaf lands as a literal null in raw config.json, which then fails the
 * `z.string().min(1)` schema on every subsequent load. So the default pick
 * writes explicit English (the provider default is English anyway), and
 * reads treat unset and `"en"` as the same default code. The equivalence is
 * provider-scoped: under a provider whose unset state means native
 * auto-detection (see `AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS`), `"en"` is
 * a real English pin and reads back as itself.
 */
const DEFAULT_WRITE_CODE = "en";

// Module-level so `select` identity only tracks real state (see
// `useSerializedConfigSelection`). The default pick writes the explicit
// English fallback described on `DEFAULT_WRITE_CODE`.
const buildLanguagePatchBody = (code: string) => ({
  services: {
    stt: {
      language: code === STT_LANGUAGE_DEFAULT_CODE ? DEFAULT_WRITE_CODE : code,
    },
  },
});

export interface UseSttLanguageSelection {
  /**
   * True only when the daemon reports the configured STT provider as
   * manually language-selectable. False for auto-detecting providers and
   * for old daemons that omit the capability field.
   */
  available: boolean;
  /**
   * The currently-selected catalog code: the pick a write is still carrying,
   * else the config value. Unset and `"en"` both read as
   * `STT_LANGUAGE_DEFAULT_CODE` (display equivalence, see
   * `DEFAULT_WRITE_CODE`), except under a provider whose unset state means
   * native auto-detection, where `"en"` reads as itself.
   */
  currentCode: string;
  /**
   * The daemon provider id a language pick steers: the configured STT
   * provider, with the legacy managed-mode config reading as `"vellum"` and
   * an unset provider as the daemon schema default (`"deepgram"`). Surfaces
   * that build their option list with `sttLanguageOptionsFor` pass this so
   * the config narrowing lives here once.
   */
  configuredProviderId: string;
  /**
   * Persist a language; hot-applies from the next spoken turn. Safe to call
   * again before the last one lands, writes are serialized in call order.
   */
  selectLanguage: (code: string) => void;
  /** A write is in flight. Stays true until the newest one settles. */
  selecting: boolean;
}

export function useSttLanguageSelection(
  assistantId: string | null,
): UseSttLanguageSelection {
  const isOrgReady = useIsOrgReady();
  const enabled = isOrgReady && !!assistantId;

  const { data: providerCatalog } = useQuery({
    ...sttProvidersGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: 30_000,
  });

  // `services.stt` falls under the ConfigGetResponse index signature
  // (`unknown`), so narrow it explicitly. Mirrors `SttProviderForm`.
  const daemonStt = daemonConfig?.services?.stt as
    | { provider?: string; mode?: string; language?: string }
    | undefined;
  // A legacy managed-mode config routes to Vellum while `provider` holds the
  // BYOK restore value; an unset provider falls back to the daemon schema
  // default (deepgram).
  const configuredProvider =
    daemonStt?.mode === "managed"
      ? "vellum"
      : (daemonStt?.provider ?? "deepgram");

  // Unknown ids and old daemons that omit the capability field read as
  // false, so the surfaces render no control rather than pretending to save
  // a language the daemon would ignore.
  const providerAcceptsLanguage =
    providerCatalog?.providers?.find((p) => p.id === configuredProvider)
      ?.languageSelection === "manual";

  // Gated on config having actually arrived: before then the configured
  // provider is a guess, and the control must not flash in and out.
  const available = enabled && !!daemonConfig && providerAcceptsLanguage;

  // Unset and the explicit English fallback both read as the default code
  // (display equivalence, see `DEFAULT_WRITE_CODE`). Not under a provider
  // whose unset state means native auto-detection: there the default row
  // reads "Auto-detect", so collapsing a persisted "en" into it would
  // misreport a real English pin as auto-detection.
  const configured = daemonStt?.language;
  const englishReadsAsDefault =
    !AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS.has(configuredProvider);
  const configuredCode =
    !configured || (englishReadsAsDefault && configured === DEFAULT_WRITE_CODE)
      ? STT_LANGUAGE_DEFAULT_CODE
      : configured;

  const {
    currentValue: currentCode,
    selecting,
    select: selectLanguage,
  } = useSerializedConfigSelection({
    assistantId,
    configuredValue: configuredCode,
    buildPatchBody: buildLanguagePatchBody,
    failureMessage: "Couldn't change the language just now. Try again.",
  });

  return {
    available,
    currentCode,
    configuredProviderId: configuredProvider,
    selectLanguage,
    selecting,
  };
}
