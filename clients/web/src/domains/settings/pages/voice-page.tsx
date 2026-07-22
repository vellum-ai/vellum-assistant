import { Info } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
import { Slider } from "@vellumai/design-library/components/slider";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { VoicePickerCard } from "@/domains/settings/pages/voice-picker-card";

import { DetailCard } from "@/components/detail-card";
import {
  DEFAULT_INTERRUPT_SENSITIVITY,
  DEFAULT_PAUSE_BEFORE_REPLY_MS,
  MAX_PAUSE_BEFORE_REPLY_MS,
  MIN_PAUSE_BEFORE_REPLY_MS,
  useVoicePrefsStore,
  type InterruptSensitivity,
} from "@/stores/voice-prefs-store";
import { VoiceTranscriptToggles } from "@/components/voice-transcript-toggles";
import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";
import {
  CTRL_PTT_ACTIVATOR,
  FN_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  activatorDisplayName,
  activatorsEqual,
  modifierLabel,
  parseActivator,
  serializeActivator,
  sortModifiers,
  type PTTActivator,
  type PTTModifier,
} from "@/utils/ptt-activator";
import {
  LS_VOICE_INPUT_DEVICE,
  getPreferredInputDeviceId,
} from "@/utils/voice-input-device";
import { canConfigureFnPushToTalk } from "@/runtime/hotkey";
import { VOICE_TRANSCRIPT_RECOMMENDATION } from "@/utils/voice-transcript-prefs";

const PTT_PRESETS: ReadonlyArray<{ label: string; activator: PTTActivator }> = [
  {
    label: "Ctrl",
    activator: { kind: "modifierOnly", modifiers: ["control"] },
  },
  {
    label: "Alt",
    activator: { kind: "modifierOnly", modifiers: ["option"] },
  },
  {
    label: "Ctrl+Shift",
    activator: { kind: "modifierOnly", modifiers: ["control", "shift"] },
  },
];

const FN_PTT_PRESET: { label: string; activator: PTTActivator } = {
  label: "Fn",
  activator: FN_PTT_ACTIVATOR,
};

const labelClasses = "text-body-small-default text-[var(--content-tertiary)]";

/**
 * Settings → Voice. One scrolling page, ordered by what people come here for:
 * the voice itself first, then the mic, then how you take a turn, then the
 * fine-tuning, then captions.
 *
 * Deliberately NOT here: the BYO text-to-speech / speech-to-text provider forms
 * (they live with every other provider on Models & Services) and the event
 * sound effects (their own Sounds page — they're notification feedback, not
 * voice).
 */
export function VoicePage() {
  return <VoiceSections />;
}

export function VoiceSections() {
  return (
    <div className="flex flex-col gap-6">
      <VoicePickerCard />
      <MicrophoneCard />
      <PushToTalkCard />
      <ConversationTuningCard />
      <CaptionsCard />
    </div>
  );
}

function CaptionsCard() {
  return (
    <DetailCard
      title="Captions"
      // Named to match the voice room's own "Captions" toggle — same two prefs,
      // so calling it "Transcription" here sent people hunting.
      subtitle="Show live text of what you and the assistant say during a voice conversation."
    >
      <div className="flex flex-col gap-2">
        <VoiceTranscriptToggles showDescription />
        <p className={`${labelClasses} pt-1`}>
          {VOICE_TRANSCRIPT_RECOMMENDATION}
        </p>
      </div>
    </DetailCard>
  );
}

const SYSTEM_DEFAULT_DEVICE = "";

function MicrophoneCard() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [deviceId, setDeviceId] = useState<string>(() =>
    getPreferredInputDeviceId(),
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((device) => device.kind === "audioinput");
      // Until mic permission is granted, browsers redact device ids and
      // labels, so inputs exist but none are selectable — offer a
      // permission prompt instead of a picker with only System Default.
      setNeedsPermission(
        inputs.length > 0 && inputs.every((device) => !device.label),
      );
      // Chromium lists "default"/"communications" pseudo-devices that mirror
      // a physical device already in the list; our own System Default option
      // covers that case without the duplicate rows.
      setDevices(
        inputs.filter(
          (device) =>
            device.deviceId !== "" &&
            device.deviceId !== "default" &&
            device.deviceId !== "communications",
        ),
      );
    } catch {
      setDevices([]);
      setNeedsPermission(false);
    }
  }, []);

  const requestMicAccess = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      // Denied or no device — the picker keeps showing System Default.
    }
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    void refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onDeviceChange = () => void refreshDevices();
    mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () =>
      mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, [refreshDevices]);

  const options = useMemo(
    () => [
      { value: SYSTEM_DEFAULT_DEVICE, label: "System Default" },
      ...devices.map((device, index) => ({
        value: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
      })),
    ],
    [devices],
  );

  const handleChange = useCallback((next: string) => {
    setDeviceId(next);
    if (next === SYSTEM_DEFAULT_DEVICE) {
      removeLocalSetting(LS_VOICE_INPUT_DEVICE);
    } else {
      setLocalSetting(LS_VOICE_INPUT_DEVICE, next);
    }
  }, []);

  // A saved device that's currently unplugged won't be in the list; show
  // System Default (capture falls back to it) without clearing the saved
  // preference, so reconnecting the device picks it back up.
  const selectedValue = options.some((option) => option.value === deviceId)
    ? deviceId
    : SYSTEM_DEFAULT_DEVICE;

  return (
    <DetailCard
      title="Microphone"
      subtitle="Which input device is used for dictation and voice conversations."
    >
      <div className="flex flex-col gap-3">
        <div className="max-w-xs">
          <Dropdown<string>
            options={options}
            value={selectedValue}
            onChange={handleChange}
            aria-label="Microphone"
          />
        </div>
        {needsPermission && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outlined" onClick={requestMicAccess}>
              Allow Microphone Access
            </Button>
            <span className={labelClasses}>
              Grant microphone access to list your available input devices.
            </span>
          </div>
        )}
      </div>
    </DetailCard>
  );
}

function PushToTalkCard() {
  const fnPushToTalkConfigurable = canConfigureFnPushToTalk();
  const [activator, setActivator] = useState<PTTActivator>(() => {
    const raw = getLocalSetting(LS_PTT_ACTIVATION_KEY, "");
    return raw
      ? parseActivator(raw, { preserveFunction: fnPushToTalkConfigurable })
      : fnPushToTalkConfigurable
        ? FN_PTT_PRESET.activator
        : { kind: "off" };
  });
  const [isRecording, setIsRecording] = useState(false);
  const [pendingModifiers, setPendingModifiers] = useState<PTTModifier[]>([]);
  const recordingZoneRef = useRef<HTMLDivElement | null>(null);
  const nonModifierPressedRef = useRef(false);
  const pttPresets = useMemo(
    () =>
      fnPushToTalkConfigurable ? [FN_PTT_PRESET, ...PTT_PRESETS] : PTT_PRESETS,
    [fnPushToTalkConfigurable],
  );

  const pttEnabled = activator.kind !== "off";
  const showFocusedTabNote = pttEnabled && !fnPushToTalkConfigurable;

  const selectActivator = useCallback((next: PTTActivator) => {
    setActivator(next);
    setLocalSetting(LS_PTT_ACTIVATION_KEY, serializeActivator(next));
    setIsRecording(false);
    setPendingModifiers([]);
  }, []);

  const beginRecording = useCallback(() => {
    setIsRecording(true);
    setPendingModifiers([]);
    nonModifierPressedRef.current = false;
    requestAnimationFrame(() => {
      recordingZoneRef.current?.focus();
    });
  }, []);

  const cancelRecording = useCallback(() => {
    setIsRecording(false);
    setPendingModifiers([]);
    nonModifierPressedRef.current = false;
  }, []);

  const collectModifiers = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): PTTModifier[] => {
      const modifiers: PTTModifier[] = [];
      if (fnPushToTalkConfigurable && event.getModifierState("Fn")) {
        modifiers.push("function");
      }
      if (event.ctrlKey) modifiers.push("control");
      if (event.altKey) modifiers.push("option");
      if (event.shiftKey) modifiers.push("shift");
      if (event.metaKey) modifiers.push("command");
      return modifiers;
    },
    [fnPushToTalkConfigurable],
  );

  const handleCaptureKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        cancelRecording();
        return;
      }

      const modifiers = collectModifiers(event);
      const key = event.key;
      const isModifierOnly =
        key === "Control" ||
        key === "Alt" ||
        key === "Shift" ||
        key === "Meta" ||
        key === "Fn";
      if (isModifierOnly) {
        setPendingModifiers(
          modifiers.includes("function")
            ? FN_PTT_ACTIVATOR.modifiers
            : sortModifiers(modifiers),
        );
        return;
      }

      if (modifiers.includes("function")) {
        selectActivator(FN_PTT_ACTIVATOR);
        return;
      }

      nonModifierPressedRef.current = true;
      const label = key.length === 1 ? key.toUpperCase() : key;
      selectActivator({ kind: "key", label, modifiers });
    },
    [cancelRecording, collectModifiers, selectActivator],
  );

  const handleCaptureKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isRecording) return;
      event.preventDefault();
      event.stopPropagation();

      const key = event.key;
      const isModifierOnly =
        key === "Control" ||
        key === "Alt" ||
        key === "Shift" ||
        key === "Meta" ||
        key === "Fn";
      if (!isModifierOnly) return;

      if (nonModifierPressedRef.current) {
        nonModifierPressedRef.current = false;
        setPendingModifiers([]);
        return;
      }

      const remaining = collectModifiers(event);
      if (remaining.length === 0 && pendingModifiers.length > 0) {
        selectActivator({
          kind: "modifierOnly",
          modifiers: pendingModifiers,
        });
      }
    },
    [collectModifiers, isRecording, pendingModifiers, selectActivator],
  );

  useEffect(() => {
    if (!isRecording) return;
    const handler = (event: MouseEvent) => {
      if (
        recordingZoneRef.current &&
        !recordingZoneRef.current.contains(event.target as Node)
      ) {
        cancelRecording();
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [cancelRecording, isRecording]);

  const isCustom =
    pttEnabled &&
    !pttPresets.some((p) => activatorsEqual(p.activator, activator));

  return (
    <DetailCard
      title="Push to Talk"
      subtitle="Hold the activation key to dictate text or start a voice conversation."
    >
      <div className="flex flex-col gap-4">
        <Toggle
          checked={pttEnabled}
          onChange={(next: boolean) => {
            if (next) {
              if (activator.kind === "off") {
                selectActivator(
                  fnPushToTalkConfigurable
                    ? FN_PTT_PRESET.activator
                    : CTRL_PTT_ACTIVATOR,
                );
              }
            } else {
              selectActivator({ kind: "off" });
            }
          }}
          label="Enable Push to Talk"
        />

        {pttEnabled && (
          <div className="flex flex-col gap-2">
            <span className={labelClasses}>Activation Key:</span>
            <div
              ref={recordingZoneRef}
              tabIndex={isRecording ? 0 : -1}
              onKeyDown={isRecording ? handleCaptureKeyDown : undefined}
              onKeyUp={isRecording ? handleCaptureKeyUp : undefined}
              className="flex flex-wrap items-center gap-2 focus:outline-none"
            >
              {pttPresets.map((preset) => {
                const selected = activatorsEqual(preset.activator, activator);
                return (
                  <ActivationKeyOption
                    key={preset.label}
                    label={preset.label}
                    selected={selected}
                    onClick={() => selectActivator(preset.activator)}
                  />
                );
              })}
              {isRecording ? (
                <ActivationKeyOption
                  label={
                    pendingModifiers.length > 0
                      ? modifierLabel(pendingModifiers)
                      : "Press any key…"
                  }
                  selected
                  recording
                  onClick={cancelRecording}
                />
              ) : (
                <ActivationKeyOption
                  label={isCustom ? activatorDisplayName(activator) : "Custom"}
                  selected={isCustom}
                  onClick={beginRecording}
                />
              )}
            </div>

            {showFocusedTabNote && (
              <div className="flex items-start gap-1 pt-1 text-body-small-default text-[var(--content-quiet)]">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  Push-to-Talk only works while this tab is focused, and
                  browsers may intercept some shortcuts (e.g. Ctrl+T) before the
                  page can see them. For always-on PTT, use the Vellum desktop
                  app.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </DetailCard>
  );
}

function ActivationKeyOption({
  label,
  selected,
  recording = false,
  onClick,
}: {
  label: string;
  selected: boolean;
  recording?: boolean;
  onClick: () => void;
}) {
  const classes = [
    "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-body-medium-lighter transition-colors",
    "border-[var(--border-subtle)]",
    selected
      ? "bg-[var(--surface-active)]"
      : "bg-[var(--surface-lift)] hover:bg-[var(--surface-hover)]",
    recording ? "animate-pulse" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" onClick={onClick} className={classes}>
      <span
        className={[
          "inline-block h-2.5 w-2.5 rounded-full border",
          selected
            ? "border-[var(--primary-base)] bg-[var(--primary-base)]"
            : "border-[var(--border-element)]",
        ].join(" ")}
      />
      <span className="text-[var(--content-default)]">{label}</span>
    </button>
  );
}

const INTERRUPT_SENSITIVITY_ITEMS: {
  value: InterruptSensitivity;
  label: string;
}[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/**
 * The two turn-taking dials, in one card because they're one idea — where the
 * boundary between your turn and the assistant's sits.
 *
 * Both are sent only when the user has set them explicitly; unset hands
 * endpointing back to the daemon's `liveVoice.vad` config. That distinction was
 * invisible before (the sliders rendered a client default while sending
 * nothing, so a self-hosted workspace saw values it wasn't running) — hence the
 * per-row "Default" state and the Reset affordance.
 */
function ConversationTuningCard() {
  const pauseMs = useVoicePrefsStore.use.pauseBeforeReplyMs();
  const setPauseMs = useVoicePrefsStore.use.setPauseBeforeReplyMs();
  const sensitivity = useVoicePrefsStore.use.interruptSensitivity();
  const setSensitivity = useVoicePrefsStore.use.setInterruptSensitivity();

  const anySet = pauseMs !== null || sensitivity !== null;

  return (
    <DetailCard
      title="Turn taking"
      subtitle="Where your turn ends and the assistant's begins. Applies to hands-free conversations — under push to talk, the key decides."
    >
      <div className="flex flex-col gap-5">
        <TuningRow
          label="Pause before reply"
          description="How long the assistant waits after you stop speaking before it replies. A longer pause lets you gather your thoughts mid-sentence without being cut off."
          isDefault={pauseMs === null}
        >
          <div className="max-w-xs">
            <Slider
              value={(pauseMs ?? DEFAULT_PAUSE_BEFORE_REPLY_MS) / 1000}
              onValueChange={(next) => {
                if (typeof next === "number")
                  setPauseMs(Math.round(next * 1000));
              }}
              min={MIN_PAUSE_BEFORE_REPLY_MS / 1000}
              max={MAX_PAUSE_BEFORE_REPLY_MS / 1000}
              step={0.1}
              showValue
              formatValue={(value) =>
                `${(typeof value === "number" ? value : value[0]).toFixed(1)}s`
              }
              aria-label="Pause before reply"
            />
          </div>
        </TuningRow>

        <TuningRow
          label="Interrupt sensitivity"
          description="How easily talking over the assistant interrupts it. Lower it if the assistant cuts itself off on background noise or filler words; raise it to interrupt more quickly."
          isDefault={sensitivity === null}
        >
          <div className="max-w-xs">
            <SegmentControl<InterruptSensitivity>
              items={INTERRUPT_SENSITIVITY_ITEMS}
              value={sensitivity ?? DEFAULT_INTERRUPT_SENSITIVITY}
              onChange={setSensitivity}
              ariaLabel="Interrupt sensitivity"
            />
          </div>
        </TuningRow>

        {anySet && (
          <div>
            <Button
              variant="outlined"
              onClick={() => {
                setPauseMs(null);
                setSensitivity(null);
              }}
            >
              Reset to defaults
            </Button>
          </div>
        )}
      </div>
    </DetailCard>
  );
}

function TuningRow({
  label,
  description,
  isDefault,
  children,
}: {
  label: string;
  description: string;
  isDefault: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-body-medium-lighter text-[var(--content-default)]">
          {label}
        </span>
        {isDefault && (
          <span className="shrink-0 rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
            Default
          </span>
        )}
      </div>
      <p className={labelClasses}>{description}</p>
      {children}
    </div>
  );
}
