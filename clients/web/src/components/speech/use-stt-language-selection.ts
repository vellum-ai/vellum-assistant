/**
 * Spoken-language selection for the speech-to-text surfaces (Settings →
 * Voice, the Models & Services provider form, and the voice first-run card,
 * hence `components/speech/` rather than any one domain). Reads the current
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
  MULTI_DEFAULT_DAEMON_PROVIDERS,
  STT_LANGUAGE_DEFAULT_CODE,
  STT_PINNED_ENGLISH_CODE,
} from "@/lib/stt/language-catalog";

import { useSerializedConfigSelection } from "@/components/speech/use-serialized-config-selection";

/**
 * How a config value reads on the picker, per provider.
 *
 * Under `MULTI_DEFAULT_DAEMON_PROVIDERS` there is no sentinel row: config
 * always carries a real language (the schema defaults it to `"multi"`), so
 * Multilingual and English are concrete, separately selectable rows and each
 * reads as itself. An absent language can only come from a daemon predating
 * that default, and on those it meant English, so that is what it shows. The
 * Multilingual row stays one click away and writes a real `"multi"`, which
 * those daemons have honored since language selection shipped.
 *
 * Natively detecting providers keep their sentinel: unset means detection
 * there, which no language code expresses.
 */
function configuredCodeForProvider(
  daemonProviderId: string,
  configured: string | undefined,
): string {
  if (configured) {
    return configured;
  }
  if (MULTI_DEFAULT_DAEMON_PROVIDERS.has(daemonProviderId)) {
    return STT_PINNED_ENGLISH_CODE;
  }
  return STT_LANGUAGE_DEFAULT_CODE;
}

/**
 * The write body for a picked code. The sentinel row (natively detecting
 * providers only) carries no code of its own, so it writes explicit English,
 * the only thing `config_patch` can express: it cannot delete the key,
 * because a `null` leaf lands in raw config.json and fails the
 * `z.string().min(1)` schema on every subsequent load.
 */
const buildLanguagePatchBody = (code: string) => ({
  services: {
    stt: {
      language: code === STT_LANGUAGE_DEFAULT_CODE ? "en" : code,
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
   * else the config value. Unset and the provider's resolved default code
   * both read as `STT_LANGUAGE_DEFAULT_CODE` (display equivalence, see
   * `defaultCodeForProvider`), so under a code-switching provider `"multi"`
   * reads as the default row while `"en"` reads as a deliberate pin.
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

  const configuredCode = configuredCodeForProvider(
    configuredProvider,
    daemonStt?.language,
  );

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
