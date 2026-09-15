/**
 * `useCompanionPickers()` fills the pickers the companion's call bar opens in
 * its popover: the microphones the call can listen through, and the voices
 * the assistant can speak in.
 *
 * The popover is its own renderer with no daemon connection, so this window
 * lists what to offer and takes the pick (see `companion-popover.ts` and
 * `companion-popover-actions.ts`). Each list is kept fresh only while its
 * picker is open, and the picker closes with the call.
 */

import { useEffect } from "react";

import {
  COMPANION_PICKER_MICROPHONES,
  COMPANION_PICKER_VOICES,
} from "@vellumai/ipc-contract";

import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import {
  closeCompanionPicker,
  useCompanionPopoverStore,
} from "@/domains/chat/companion-popover";
import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { t } from "@/i18n";
import {
  groupVoicesByAccent,
  voiceTraitsLabel,
} from "@/lib/tts/managed-voice-catalog";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  getPreferredInputDeviceId,
  listVoiceInputDevices,
  watchPreferredInputDevice,
} from "@/utils/voice-input-device";

export function useCompanionPickers(): void {
  const openPicker = useCompanionPopoverStore((state) => state.openPicker);
  const microphonesOpen = openPicker === COMPANION_PICKER_MICROPHONES;
  const voicesOpen = openPicker === COMPANION_PICKER_VOICES;

  // A picker belongs to the call it was opened on.
  useEffect(
    () =>
      useLiveVoiceStore.subscribe((state) => {
        if (!isLiveVoiceSessionActive(state.state)) {
          closeCompanionPicker();
        }
      }),
    [],
  );

  useEffect(() => {
    if (!microphonesOpen) {
      useCompanionPopoverStore.setState({ microphones: null });
      return;
    }
    let stale = false;
    const refresh = async (): Promise<void> => {
      const list = await listVoiceInputDevices();
      if (stale) {
        return;
      }
      const selected = getPreferredInputDeviceId();
      const options = list.devices.map((device, index) => ({
        id: device.deviceId,
        label:
          device.label ||
          t("companionPopover.microphoneFallback", { index: index + 1 }),
      }));
      // A saved microphone that is not plugged in keeps its row, as it does
      // in Settings: capture has already fallen back, and the row is what
      // makes System Default a change that clears it.
      if (
        selected !== "" &&
        !options.some((option) => option.id === selected)
      ) {
        options.push({
          id: selected,
          label: list.known
            ? t("companionPopover.savedMicrophoneNotConnected")
            : t("companionPopover.savedMicrophone"),
        });
      }
      useCompanionPopoverStore.setState({
        microphones: {
          options,
          selected,
          needsPermission: list.needsPermission,
        },
      });
    };
    void refresh();
    const unwatch = watchPreferredInputDevice(() => {
      void refresh();
    });
    const mediaDevices =
      typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    const onDeviceChange = (): void => {
      void refresh();
    };
    mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      stale = true;
      unwatch();
      mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, [microphonesOpen]);

  // Read raw rather than through `useActiveAssistantId`: this runs in the
  // root layout, where welcome and onboarding have no assistant yet.
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const inCall = useLiveVoiceStore((state) =>
    isLiveVoiceSessionActive(state.state),
  );
  // Handed an assistant only during a call, which is when the call bar asks
  // whether there are voices to offer. Off the call its queries stay off.
  const { available, voices, currentModel, defaultModel, selectModel } =
    useManagedVoiceSelection(inCall ? activeAssistantId : null);

  // Whether the voice chevron has anything to open: an assistant on its own
  // speech provider, or a daemon without voice selection, has no catalog.
  useEffect(() => {
    useCompanionPopoverStore.setState({ voicesPickable: inCall && available });
  }, [inCall, available]);

  useEffect(() => {
    if (!voicesOpen || !available) {
      useCompanionPopoverStore.setState({ voices: null });
      return;
    }
    useCompanionPopoverStore.setState({
      voices: {
        groups: groupVoicesByAccent(voices).map((group) => ({
          accent: group.accent,
          voices: group.voices.map((voice) => ({
            id: voice.model,
            label: voiceTraitsLabel(voice.description),
            sampleUrl: voice.sampleUrl,
            isDefault: voice.model === defaultModel,
          })),
        })),
        selected: currentModel,
        select: selectModel,
      },
    });
  }, [voicesOpen, available, voices, currentModel, defaultModel, selectModel]);
}
