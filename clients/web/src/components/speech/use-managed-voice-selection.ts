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

import { useCallback, useMemo, useRef, useState } from "react";

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
  /**
   * The currently-selected model: the pick a write is still carrying, else the
   * config value, else the platform default.
   */
  currentModel: string;
  /** The platform default model, for a "(default)" marker. Empty if none. */
  defaultModel: string;
  /**
   * Persist a voice; hot-applies on the assistant's next spoken turn. Safe to
   * call again before the last one lands — writes are serialized in call order.
   */
  selectModel: (model: string) => void;
  /** A write is in flight. Stays true until the newest one settles. */
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

  const [selecting, setSelecting] = useState(false);
  // The voice a pick is heading for, held until its write has landed in config.
  // Auditioning voices in a row is the point of the picker, and a check mark
  // that waits out a round trip reads as a dropped click.
  const [pendingModel, setPendingModel] = useState<string | null>(null);

  const currentModel = useMemo(() => {
    const configured = daemonTts?.providers?.vellum?.model;
    return (
      pendingModel ??
      configured ??
      defaultModel ??
      voices[0]?.model ??
      ""
    );
  }, [pendingModel, daemonTts, defaultModel, voices]);

  // Writes run one at a time in click order, and only the newest one settles the
  // UI. Concurrent PATCHes of the same config field can arrive out of order —
  // config would then keep whichever landed last rather than what was clicked
  // last, and the first response back would clear `selecting` while a later
  // write was still in flight.
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const latestWrite = useRef(0);

  const selectModel = useCallback(
    (model: string) => {
      if (!assistantId || model === currentModel) return;
      const seq = ++latestWrite.current;
      setPendingModel(model);
      setSelecting(true);
      writeChain.current = writeChain.current.then(async () => {
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
        } catch {
          toast.error("Couldn't change the voice just now — try again.");
        } finally {
          // Superseded writes leave the state alone: the pick they'd revert to
          // is not the one the user is waiting on. Dropping the pending model
          // here also reverts a failed write to whatever config actually holds.
          if (seq === latestWrite.current) {
            setPendingModel(null);
            setSelecting(false);
          }
        }
      });
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
