/**
 * Managed-voice selection for every surface that offers a voice (the first-run
 * modal, the voice-room settings popover, and the Voice settings page — hence
 * `components/speech/` rather than either domain). Reads the current voice from
 * daemon config and writes the
 * chosen one back — the source of truth is `services.tts.providers.vellum.model`,
 * never a client store (server data has one owner).
 *
 * **Hot-apply:** live-voice resolves its TTS provider from `getConfig()` fresh on
 * every spoken turn, and the daemon's `config_patch` handler invalidates the
 * config cache + reinitializes providers. So writing the model here takes effect
 * on the assistant's *next* reply within the same session — the same mid-call
 * voice change the phone `voice_config_update` path gives, with no session
 * runtime message.
 *
 * Only offered for managed (Vellum) assistants whose daemon advertises voice
 * selection — BYO providers pick their voice on Settings → Models & Services,
 * with the rest of their provider config. When
 * unavailable, `available` is false and the surfaces render no picker.
 */

import { useCallback, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import {
  configGetOptions,
  configGetQueryKey,
  ttsProvidersGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch } from "@/generated/daemon/sdk.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  useManagedVoices,
  type ManagedVoiceOption,
} from "@/lib/tts/use-managed-voices";

export interface UseManagedVoiceSelection {
  /** True only when this assistant is managed and its daemon offers voice selection. */
  available: boolean;
  /**
   * The assistant speaks through a provider the user configured themselves —
   * there is no catalog to pick from, and its voice is set on Settings → Models
   * & Services. Distinct from `!available`, which is also false while config is
   * still loading: this stays false until config says so, so a surface can show
   * a "set it in Settings" state without flashing it during the fetch.
   */
  isByok: boolean;
  voices: readonly ManagedVoiceOption[];
  /** The currently-selected model (config value, else the platform default). */
  currentModel: string;
  /** The platform default model, for a "(default)" marker. Empty if none. */
  defaultModel: string;
  /** Persist a voice; hot-applies on the assistant's next spoken turn. */
  selectModel: (model: string) => void;
  /** A write is in flight. */
  selecting: boolean;
}

export function useManagedVoiceSelection(
  assistantId: string | null,
): UseManagedVoiceSelection {
  const isOrgReady = useIsOrgReady();
  const enabled = isOrgReady && !!assistantId;
  const queryClient = useQueryClient();

  const { data: providerCatalog } = useQuery({
    ...ttsProvidersGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: 30_000,
  });

  // `services.tts` falls under the ConfigGetResponse index signature (`unknown`),
  // so narrow it explicitly. Mirrors the Settings card.
  const daemonTts = daemonConfig?.services?.tts as
    | { provider?: string; mode?: string; providers?: { vellum?: { model?: string } } }
    | undefined;
  const isManaged =
    daemonTts?.mode === "managed" || daemonTts?.provider === "vellum";

  // Only new daemons report vellum as voice-selectable; an old daemon (or an
  // unfetched catalog) reports false, hiding the picker so we never claim to
  // save a voice the daemon would ignore.
  const vellumSupportsVoiceSelection =
    providerCatalog?.providers?.find((p) => p.id === "vellum")
      ?.supportsVoiceSelection === true;

  const { voices, defaultModel } = useManagedVoices(assistantId, {
    enabled: enabled && isManaged,
  });

  const available =
    enabled && isManaged && vellumSupportsVoiceSelection && voices.length > 0;
  // Gated on config having actually arrived — an unfetched config reads as
  // "not managed", which would flash the BYO state on every mount.
  const isByok = enabled && !!daemonConfig && !isManaged;

  const currentModel = useMemo(() => {
    const configured = daemonTts?.providers?.vellum?.model;
    return (
      configured ??
      defaultModel ??
      voices[0]?.model ??
      ""
    );
  }, [daemonTts, defaultModel, voices]);

  const [selecting, setSelecting] = useState(false);
  const selectModel = useCallback(
    (model: string) => {
      if (!assistantId || model === currentModel) return;
      setSelecting(true);
      void (async () => {
        try {
          const { response } = await configPatch({
            path: { assistant_id: assistantId },
            body: { services: { tts: { providers: { vellum: { model } } } } },
            throwOnError: false,
          });
          if (!response?.ok) {
            toast.error("Couldn't change the voice just now — try again.");
            return;
          }
          // Refetch config so `currentModel` reflects the write. The running
          // session picks the new voice up from config on its next turn.
          await queryClient.invalidateQueries({
            queryKey: configGetQueryKey({
              path: { assistant_id: assistantId },
            }),
          });
        } finally {
          setSelecting(false);
        }
      })();
    },
    [assistantId, currentModel, queryClient],
  );

  return {
    available,
    isByok,
    voices,
    currentModel,
    defaultModel: defaultModel ?? "",
    selectModel,
    selecting,
  };
}
