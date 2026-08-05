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

import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  configGetOptions,
  sttProvidersGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS,
  MULTI_DEFAULT_DAEMON_PROVIDERS,
  STT_LANGUAGE_DEFAULT_CODE,
  STT_MULTI_CODE,
} from "@/lib/stt/language-catalog";

import { useSerializedConfigSelection } from "@/components/speech/use-serialized-config-selection";
import {
  resolveSupportsMultilingualSttDefault,
  useSupportsMultilingualSttDefault,
} from "@/lib/backwards-compat/use-supports-multilingual-stt-default";

/**
 * The code written when the user picks the default option, and the code a
 * read collapses back into it. The daemon cannot delete
 * `services.stt.language`: `config_patch` deep-merges, and a `null` leaf
 * lands as a literal null in raw config.json, which then fails the
 * `z.string().min(1)` schema on every subsequent load. So the default pick
 * writes whatever code the daemon would have resolved the unset state to,
 * and reads treat that code and unset as the same default row.
 *
 * Which code that is depends on the provider:
 *
 * - Code-switching providers (`MULTI_DEFAULT_DAEMON_PROVIDERS`) resolve unset
 *   to `"multi"`, so that is both the write and the collapse. `"en"` under
 *   them is a deliberate English pin and reads back as itself.
 * - Natively auto-detecting providers have no code that means detection, so
 *   nothing collapses and the default row is unreachable once a language is
 *   pinned (`STT_AUTO_DETECT_OPTION` says so plainly).
 * - Anything else keeps the historical English equivalence.
 */
function defaultCodeForProvider(
  daemonProviderId: string,
  daemonDefaultsToMulti: boolean,
): string | null {
  if (
    daemonDefaultsToMulti &&
    MULTI_DEFAULT_DAEMON_PROVIDERS.has(daemonProviderId)
  ) {
    return STT_MULTI_CODE;
  }
  if (AUTO_DETECT_WHEN_UNSET_DAEMON_PROVIDERS.has(daemonProviderId)) {
    return null;
  }
  return "en";
}

/**
 * The write body for a picked code. The default row carries no code of its
 * own, so it writes the provider's resolved default instead; a provider with
 * no such code (native detection) writes explicit English, the only thing
 * `config_patch` can express.
 *
 * Async because which code that is depends on the assistant version, and the
 * render-time gate reads `false` until identity hydrates. A default pick
 * during that window would otherwise persist explicit English on an assistant
 * whose real default is code-switching, and `config_patch` cannot delete the
 * key afterwards. So the write resolves the version instead of sampling it.
 */
const buildPatchBodyForProvider =
  (daemonProviderId: string, assistantId: string | null) =>
  async (code: string) => {
    if (code !== STT_LANGUAGE_DEFAULT_CODE) {
      return { services: { stt: { language: code } } };
    }
    const defaultsToMulti =
      await resolveSupportsMultilingualSttDefault(assistantId);
    return {
      services: {
        stt: {
          language:
            defaultCodeForProvider(daemonProviderId, defaultsToMulti) ?? "en",
        },
      },
    };
  };

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
   * Whether the connected assistant resolves an unset language to
   * code-switching rather than English. Surfaces pass this alongside
   * `configuredProviderId` to every catalog helper, so a bundle talking to a
   * pre-0.12.0 assistant keeps describing the English default that assistant
   * still applies. See `use-supports-multilingual-stt-default.ts`.
   */
  daemonDefaultsToMulti: boolean;
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
  // Scoped to the assistant whose config this hook reads, and conservative
  // until its version hydrates: the pre-0.12.0 English framing is what every
  // assistant did before, so showing it briefly is the safe direction.
  const daemonDefaultsToMulti = useSupportsMultilingualSttDefault(assistantId);

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

  // Unset and the provider's resolved default code both read as the default
  // row (display equivalence, see `defaultCodeForProvider`). Under a
  // code-switching provider that code is "multi", so a persisted "en" is a
  // real English pin and reads as itself; under a natively detecting one
  // nothing collapses at all.
  const configured = daemonStt?.language;
  const defaultCode = defaultCodeForProvider(
    configuredProvider,
    daemonDefaultsToMulti,
  );
  const configuredCode =
    !configured || (defaultCode !== null && configured === defaultCode)
      ? STT_LANGUAGE_DEFAULT_CODE
      : configured;

  // Memoized rather than module-level (the body now depends on the provider)
  // so `select` identity still only tracks real state, per
  // `useSerializedConfigSelection`.
  // Keyed on the provider and the owning assistant only: the gate value is
  // resolved inside the write rather than captured here, so a version that
  // hydrates mid-flight cannot leave a stale builder behind.
  const buildLanguagePatchBody = useMemo(
    () => buildPatchBodyForProvider(configuredProvider, assistantId),
    [configuredProvider, assistantId],
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
    daemonDefaultsToMulti,
    selectLanguage,
    selecting,
  };
}
