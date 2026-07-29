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

import { useCallback, useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import {
  configGetOptions,
  configGetQueryKey,
  sttProvidersGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch } from "@/generated/daemon/sdk.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { STT_LANGUAGE_DEFAULT_CODE } from "@/lib/stt/language-catalog";

/**
 * The code written when the user picks the default option. The daemon cannot
 * delete `services.stt.language`: `config_patch` deep-merges, and a `null`
 * leaf lands as a literal null in raw config.json, which then fails the
 * `z.string().min(1)` schema on every subsequent load. So the default pick
 * writes explicit English (the provider default is English anyway), and
 * reads treat unset and `"en"` as the same default code.
 */
const DEFAULT_WRITE_CODE = "en";

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
   * `DEFAULT_WRITE_CODE`).
   */
  currentCode: string;
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
  const queryClient = useQueryClient();

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

  const providerAcceptsLanguage =
    providerCatalog?.providers?.find((p) => p.id === configuredProvider)
      ?.languageSelection === "manual";

  // Gated on config having actually arrived: before then the configured
  // provider is a guess, and the control must not flash in and out.
  const available = enabled && !!daemonConfig && providerAcceptsLanguage;

  const [selecting, setSelecting] = useState(false);
  // The code a pick is heading for, held until its write has landed in
  // config. A check mark that waits out a round trip reads as a dropped
  // click.
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  const currentCode = useMemo(() => {
    const configured = daemonStt?.language;
    const normalized =
      !configured || configured === DEFAULT_WRITE_CODE
        ? STT_LANGUAGE_DEFAULT_CODE
        : configured;
    return pendingCode ?? normalized;
  }, [pendingCode, daemonStt]);

  // Writes run one at a time in click order, and only the newest one settles
  // the UI. Concurrent PATCHes of the same config field can arrive out of
  // order: config would then keep whichever landed last rather than what was
  // clicked last, and the first response back would clear `selecting` while
  // a later write was still in flight.
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const latestWrite = useRef(0);

  const selectLanguage = useCallback(
    (code: string) => {
      if (!assistantId || code === currentCode) {
        return;
      }
      const seq = ++latestWrite.current;
      setPendingCode(code);
      setSelecting(true);
      writeChain.current = writeChain.current.then(async () => {
        try {
          const writeCode =
            code === STT_LANGUAGE_DEFAULT_CODE ? DEFAULT_WRITE_CODE : code;
          const { response } = await configPatch({
            path: { assistant_id: assistantId },
            body: { services: { stt: { language: writeCode } } },
            throwOnError: false,
          });
          if (!response?.ok) {
            toast.error("Couldn't change the language just now. Try again.");
            return;
          }
          // Refetch config so `currentCode` reflects the write. The running
          // session picks the new language up from config on its next turn.
          await queryClient.invalidateQueries({
            queryKey: configGetQueryKey({
              path: { assistant_id: assistantId },
            }),
          });
        } catch {
          toast.error("Couldn't change the language just now. Try again.");
        } finally {
          // Superseded writes leave the state alone: the pick they'd revert
          // to is not the one the user is waiting on. Dropping the pending
          // code here also reverts a failed write to whatever config holds.
          if (seq === latestWrite.current) {
            setPendingCode(null);
            setSelecting(false);
          }
        }
      });
    },
    [assistantId, currentCode, queryClient],
  );

  return { available, currentCode, selectLanguage, selecting };
}
