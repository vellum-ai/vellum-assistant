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

import { useQuery } from "@tanstack/react-query";

import {
  configGetOptions,
  ttsProvidersGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import {
  useManagedVoices,
  type ManagedVoiceOption,
} from "@/lib/tts/use-managed-voices";

import { useSerializedConfigSelection } from "@/components/speech/use-serialized-config-selection";

// Module-level so `select` identity only tracks real state (see
// `useSerializedConfigSelection`).
const buildVoicePatchBody = (model: string) => ({
  services: { tts: { providers: { vellum: { model } } } },
});

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
  /**
   * Every fetch that decides `available` has concluded (or was never going to
   * run: no assistant, or an organization that resolved to nothing). Until then
   * `available` and `isByok` are both false and say nothing about each other,
   * so a surface with no picker to show can hold its chrome back rather than
   * draw an empty box that never fills.
   */
  settled: boolean;
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
  const orgReadiness = useOrgHeaderReadiness();
  const enabled = orgReadiness === "ready" && !!assistantId;

  const { data: providerCatalog, isLoading: catalogLoading } = useQuery({
    ...ttsProvidersGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  const { data: daemonConfig, isLoading: configLoading } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled,
    staleTime: 30_000,
  });

  // `services.tts` falls under the ConfigGetResponse index signature (`unknown`),
  // so narrow it explicitly. Mirrors the Settings card.
  const daemonTts = daemonConfig?.services?.tts as
    | {
        provider?: string;
        mode?: string;
        providers?: { vellum?: { model?: string } };
      }
    | undefined;
  const isManaged =
    daemonTts?.mode === "managed" || daemonTts?.provider === "vellum";

  // Only new daemons report vellum as voice-selectable; an old daemon (or an
  // unfetched catalog) reports false, hiding the picker so we never claim to
  // save a voice the daemon would ignore.
  const vellumSupportsVoiceSelection =
    providerCatalog?.providers?.find((p) => p.id === "vellum")
      ?.supportsVoiceSelection === true;

  const {
    voices,
    defaultModel,
    loading: voicesLoading,
  } = useManagedVoices(assistantId, {
    enabled: enabled && isManaged,
  });

  const available =
    enabled && isManaged && vellumSupportsVoiceSelection && voices.length > 0;
  // Gated on config having actually arrived — an unfetched config reads as
  // "not managed", which would flash the BYO state on every mount.
  const isByok = enabled && !!daemonConfig && !isManaged;
  // "Nothing is in flight, and nothing is waiting to start." Each `isLoading`
  // is false for a query that is disabled or has failed, so the states that
  // never produce a picker (no assistant, an org that resolved to nothing, an
  // old daemon, a catalog that failed or came back empty) settle rather than
  // read as perpetually loading. `"resolving"` is the one wait not expressed as
  // a query: it disables all three, and they'd otherwise look settled.
  const settled =
    orgReadiness !== "resolving" &&
    !catalogLoading &&
    !configLoading &&
    !voicesLoading;

  const configuredModel =
    daemonTts?.providers?.vellum?.model ??
    defaultModel ??
    voices[0]?.model ??
    "";

  const {
    currentValue: currentModel,
    selecting,
    select: selectModel,
  } = useSerializedConfigSelection({
    assistantId,
    configuredValue: configuredModel,
    buildPatchBody: buildVoicePatchBody,
    failureMessage: "Couldn't change the voice just now. Try again.",
  });

  return {
    available,
    isByok,
    settled,
    voices,
    currentModel,
    defaultModel: defaultModel ?? "",
    selectModel,
    selecting,
  };
}
