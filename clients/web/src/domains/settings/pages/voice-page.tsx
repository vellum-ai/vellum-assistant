import { ArrowUpRight, Info } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, Navigate, useSearchParams } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Select } from "@vellumai/design-library/components/select";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
import { Slider } from "@vellumai/design-library/components/slider";
import { ShortcutKeys } from "@vellumai/design-library/components/shortcut-keys";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { ListeningLanguageCard } from "@/domains/settings/pages/listening-language-card";
import { VoicePickerCard } from "@/domains/settings/pages/voice-picker-card";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { isElectron } from "@/runtime/is-electron";
import { useFnRegistrationStore } from "@/stores/fn-registration-store";
import { useHotkeyRecorder } from "@/domains/settings/keyboard-shortcuts/use-hotkey-recorder";
import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";

import { DetailCard } from "@/components/detail-card";
import { useTranslation } from "@/i18n";
import {
  DEFAULT_INTERRUPT_SENSITIVITY,
  DEFAULT_PAUSE_BEFORE_REPLY_MS,
  MAX_PAUSE_BEFORE_REPLY_MS,
  MIN_PAUSE_BEFORE_REPLY_MS,
  useVoicePrefsStore,
  type InterruptSensitivity,
} from "@/stores/voice-prefs-store";
import { VoiceTranscriptToggles } from "@/components/voice-transcript-toggles";
import { removeLocalSetting, setLocalSetting } from "@/utils/local-settings";
import {
  FN_PTT_ACTIVATOR,
  activatorDisplayName,
  activatorsEqual,
  modifierLabel,
  sortModifiers,
  type PTTModifier,
} from "@/utils/ptt-activator";
import {
  defaultVoiceModeActivator,
  isFnVoiceModeActivator,
  keyboardDefaultActivator,
  readVoiceModeActivator,
  supportsBareModifierVoiceMode,
  writeVoiceModeActivator,
  type VoiceModeActivator,
} from "@/utils/voice-mode-activation";
import {
  LS_VOICE_INPUT_DEVICE,
  getPreferredInputDeviceId,
} from "@/utils/voice-input-device";
import { supportsFnPushToTalk } from "@/runtime/hotkey";
import { routes } from "@/utils/routes";
import { VOICE_TRANSCRIPT_RECOMMENDATION } from "@/utils/voice-transcript-prefs";

const labelClasses = "text-body-small-default text-[var(--content-tertiary)]";

/**
 * Settings → Voice, split into the two halves of a spoken conversation so
 * output settings and input settings don't sit in one undifferentiated stack:
 *
 *  - **Output** — how the assistant sounds (its voice).
 *  - **Input**: how you talk to it (mic, spoken language, push to talk, turn
 *    taking).
 *  - **Captions** — reading along, which belongs to neither half, so it trails
 *    on its own.
 *
 * Deliberately NOT here: the BYO text-to-speech / speech-to-text provider forms
 * (they live with every other provider on Models & Services) and the event
 * sound effects (their own Sounds page — they're notification feedback, not
 * voice). The listening language is the one speech-to-text setting that does
 * belong: it describes the speaker rather than the service, and someone whose
 * assistant is mishearing them looks for it here, not among the API keys.
 */
export function VoicePage() {
  // Honor legacy deep links from when this page carried Sounds and Services
  // tabs: those moved to their own pages, but bookmarks and native links to
  // `?tab=sounds` / `?tab=services` are part of the URL contract.
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab");
  if (tab === "sounds") {
    return <Navigate replace to={routes.settings.sounds} />;
  }
  if (tab === "services") {
    return <Navigate replace to={routes.settings.ai} />;
  }
  return <VoiceSections />;
}

export function VoiceSections() {
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-col gap-8">
      <VoiceSection
        heading={t("voicePage.sectionOutputHeading")}
        description={t("voicePage.sectionOutputDescription")}
      >
        <VoicePickerCard />
        <SpeechServicesBanner />
      </VoiceSection>

      <VoiceSection
        heading={t("voicePage.sectionInputHeading")}
        description={t("voicePage.sectionInputDescription")}
      >
        <MicrophoneCard />
        <ListeningLanguageCard />
        <VoiceModeShortcutCard />
        <ConversationTuningCard />
      </VoiceSection>

      <VoiceSection heading={t("voicePage.sectionCaptionsHeading")}>
        <CaptionsCard />
      </VoiceSection>
    </div>
  );
}

/**
 * Pointer to Models & Services, which carries the BYO speech providers (they
 * live with every other provider there, not on this page) and the managed
 * custom-voice-ID entry: most people want the managed voice above, but those
 * bringing their own key or a specific voice ID need a way across.
 *
 * Shown only alongside the managed picker. An assistant already on its own
 * provider gets that same pointer from the card itself, which has nothing else
 * to offer — a second copy of the sentence directly beneath it just repeats.
 */
function SpeechServicesBanner() {
  const { t } = useTranslation("settings");
  const { available } = useManagedVoiceSelection(useActiveAssistantId());

  if (!available) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 text-body-small-default text-[var(--content-tertiary)]">
      <Info className="h-3.5 w-3.5 shrink-0 text-[var(--content-quiet)]" />
      <span>{t("voicePage.speechServicesBannerPrompt")}</span>
      <Link
        to={`${routes.settings.ai}#text-to-speech`}
        className="inline-flex items-center gap-1 text-[var(--content-secondary)] underline decoration-[var(--border-element)] underline-offset-2 hover:text-[var(--content-default)]"
      >
        {t("voicePage.speechServicesBannerLink")}
        <ArrowUpRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

function VoiceSection({
  heading,
  description,
  children,
}: {
  heading: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label-medium-default uppercase tracking-wide text-[var(--content-tertiary)]">
          {heading}
        </h2>
        {description && (
          <p className="text-body-small-default text-[var(--content-quiet)]">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function CaptionsCard() {
  const { t } = useTranslation("settings");

  return (
    <DetailCard
      title={t("voicePage.captionsTitle")}
      // Named to match the voice room's own "Captions" toggle — same two prefs,
      // so calling it "Transcription" here sent people hunting.
      subtitle={t("voicePage.captionsSubtitle")}
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

/**
 * Stored value meaning "use whatever the OS picks". Shared with
 * `voice-input-device.ts`, which reads the same key, so the storage shape
 * cannot change.
 */
const SYSTEM_DEFAULT_DEVICE = "";

function MicrophoneCard() {
  const { t } = useTranslation("settings");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [needsPermission, setNeedsPermission] = useState(false);
  // Whether the browser has given us a list we can draw conclusions from.
  // Before the first enumeration resolves, and while permission is withheld
  // (ids come back redacted and are filtered out), an absent device says
  // nothing about whether it is plugged in.
  const [deviceListIsKnown, setDeviceListIsKnown] = useState(false);
  const [deviceId, setDeviceId] = useState<string>(() =>
    getPreferredInputDeviceId(),
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }
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
      setDeviceListIsKnown(
        inputs.length === 0 || inputs.some((d) => !!d.label),
      );
    } catch {
      setDevices([]);
      setNeedsPermission(false);
      setDeviceListIsKnown(false);
    }
  }, []);

  const requestMicAccess = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      for (const track of stream.getTracks()) {
        track.stop();
      }
    } catch {
      // Denied or no device — the picker keeps showing System Default.
    }
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    void refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) {
      return;
    }
    const onDeviceChange = () => void refreshDevices();
    mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () =>
      mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, [refreshDevices]);

  const options = useMemo(() => {
    const live = devices.map((device, index) => ({
      value: device.deviceId,
      label:
        device.label ||
        t("voicePage.microphoneFallbackLabel", { index: index + 1 }),
    }));
    // A saved device absent from the list keeps its own row rather than being
    // displayed as System Default: capture already falls back, so the
    // preference survives for when the device returns, and showing it is what
    // makes System Default a real change that can clear it.
    //
    // Only claim it is disconnected once the list is worth trusting. An
    // unresolved or permission-redacted list is empty for reasons that have
    // nothing to do with the device.
    const savedIsAbsent =
      deviceId !== SYSTEM_DEFAULT_DEVICE &&
      !live.some((option) => option.value === deviceId);
    return [
      { value: null, label: t("voicePage.systemDefault") },
      ...live,
      ...(savedIsAbsent
        ? [
            {
              value: deviceId,
              label: deviceListIsKnown
                ? t("voicePage.savedMicrophoneNotConnected")
                : t("voicePage.savedMicrophone"),
            },
          ]
        : []),
    ];
  }, [devices, deviceId, deviceListIsKnown, t]);

  const handleChange = useCallback((next: string) => {
    setDeviceId(next);
    if (next === SYSTEM_DEFAULT_DEVICE) {
      removeLocalSetting(LS_VOICE_INPUT_DEVICE);
    } else {
      setLocalSetting(LS_VOICE_INPUT_DEVICE, next);
    }
  }, []);

  const selectedValue = deviceId === SYSTEM_DEFAULT_DEVICE ? null : deviceId;

  return (
    <DetailCard
      title={t("voicePage.microphoneTitle")}
      subtitle={t("voicePage.microphoneSubtitle")}
    >
      <div className="flex flex-col gap-3">
        <div className="max-w-xs">
          <Select<string>
            options={options}
            value={selectedValue}
            onChange={handleChange}
            onSelectNone={() => handleChange(SYSTEM_DEFAULT_DEVICE)}
            aria-label={t("voicePage.microphoneAriaLabel")}
          />
        </div>
        {needsPermission && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outlined" onClick={requestMicAccess}>
              {t("voicePage.allowMicrophoneAccess")}
            </Button>
            <span className={labelClasses}>
              {t("voicePage.grantMicrophoneAccessHint")}
            </span>
          </div>
        )}
      </div>
    </DetailCard>
  );
}

/** Keys that only ever appear as part of a chord, never as its subject. */
const MODIFIER_KEY_NAMES = new Set(["Control", "Alt", "Shift", "Meta", "Fn"]);

/**
 * The binding that starts and ends a voice conversation.
 *
 * Records a chord rather than a bare modifier: voice mode is a toggle, so a
 * modifier-only binding would fire on every abandoned Ctrl chord. Fn is the
 * one exception the recorder accepts on its own, and only on a desktop host
 * that can see it.
 */
/** The Keyboard Shortcuts key the desktop host binds Talk to, globally. */
const TALK_HOTKEY_KEY = "toggleVoice";

/**
 * Bare-modifier taps for the Windows desktop host, where Fn does not exist
 * (the keyboard firmware handles it; the OS never sees a key event). Bound as
 * focused-window tap listeners in `use-voice-mode-hotkey`, since an Electron
 * `globalShortcut` cannot express a bare modifier.
 */
const BARE_MODIFIER_PRESETS: ReadonlyArray<{
  label: string;
  activator: VoiceModeActivator;
}> = [
  {
    label: "Ctrl+Shift",
    activator: { kind: "modifierOnly", modifiers: ["control", "shift"] },
  },
  {
    label: "Alt",
    activator: { kind: "modifierOnly", modifiers: ["option"] },
  },
];

function VoiceModeShortcutCard() {
  const { t } = useTranslation("settings");
  const fnConfigurable = supportsFnPushToTalk();
  /**
   * On the desktop app the keyboard binding is an Electron `globalShortcut`
   * the host owns, listed in Keyboard Shortcuts as "Talk". This card does not
   * record chords there: it would be writing a second binding that nothing
   * reads. Fn is the one thing still configured here, since it is not an
   * accelerator and cannot live on that rail.
   */
  const desktopHost = isElectron();
  // `false` only after an attempt was refused; `null` means none was made.
  const fnRefused =
    useFnRegistrationStore((state) => state.registered) === false;
  const [activator, setActivator] = useState<VoiceModeActivator>(() =>
    readVoiceModeActivator(fnConfigurable),
  );
  const [isRecording, setIsRecording] = useState(false);
  const [pendingModifiers, setPendingModifiers] = useState<PTTModifier[]>([]);
  const [showChordHint, setShowChordHint] = useState(false);
  const recordingZoneRef = useRef<HTMLDivElement | null>(null);

  const presets = useMemo(() => {
    const keyboard = keyboardDefaultActivator();
    const keyboardPreset = {
      label: activatorDisplayName(keyboard),
      activator: keyboard,
    };
    return fnConfigurable
      ? [{ label: "Fn", activator: FN_PTT_ACTIVATOR }, keyboardPreset]
      : [keyboardPreset];
  }, [fnConfigurable]);

  const shortcutEnabled = activator.kind !== "off";

  const selectActivator = useCallback((next: VoiceModeActivator) => {
    setActivator(next);
    writeVoiceModeActivator(next);
    setIsRecording(false);
    setPendingModifiers([]);
    setShowChordHint(false);
  }, []);

  /**
   * Fn and a recorded chord are one choice, not two settings: the row asks
   * what starts Talk and takes one answer. Recording therefore clears Fn, and
   * choosing Fn clears the chord, so the selected chip is always the truth.
   */
  const recorder = useHotkeyRecorder({
    onBound: () => selectActivator({ kind: "off" }),
  });
  const talkHotkey = recorder.catalog.find(
    (entry) => entry.key === TALK_HOTKEY_KEY,
  );
  const talkAccelerator = talkHotkey?.accelerator ?? "";
  const recordingTalk = recorder.recordingKey === TALK_HOTKEY_KEY;
  const chooseFn = useCallback(() => {
    selectActivator(FN_PTT_ACTIVATOR);
    recorder.removeHotkey(TALK_HOTKEY_KEY);
  }, [recorder, selectActivator]);

  // Like Fn, a bare-modifier tap is an answer to the same one question, so
  // choosing one also clears the recorded Talk chord.
  const bareModifierPresets = supportsBareModifierVoiceMode()
    ? BARE_MODIFIER_PRESETS
    : [];
  const chooseBareModifier = useCallback(
    (next: VoiceModeActivator) => {
      selectActivator(next);
      recorder.removeHotkey(TALK_HOTKEY_KEY);
    },
    [recorder, selectActivator],
  );

  // "Nothing" is also an answer to the one question: clear the Fn binding
  // and the recorded Talk chord so no keyboard path starts a session.
  const chooseOff = useCallback(() => {
    selectActivator({ kind: "off" });
    recorder.removeHotkey(TALK_HOTKEY_KEY);
  }, [recorder, selectActivator]);

  const beginRecording = useCallback(() => {
    setIsRecording(true);
    setPendingModifiers([]);
    setShowChordHint(false);
    requestAnimationFrame(() => {
      recordingZoneRef.current?.focus();
    });
  }, []);

  const cancelRecording = useCallback(() => {
    setIsRecording(false);
    setPendingModifiers([]);
    setShowChordHint(false);
  }, []);

  const collectModifiers = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): PTTModifier[] => {
      const modifiers: PTTModifier[] = [];
      if (fnConfigurable && event.getModifierState("Fn")) {
        modifiers.push("function");
      }
      if (event.ctrlKey) {
        modifiers.push("control");
      }
      if (event.altKey) {
        modifiers.push("option");
      }
      if (event.shiftKey) {
        modifiers.push("shift");
      }
      if (event.metaKey) {
        modifiers.push("command");
      }
      return modifiers;
    },
    [fnConfigurable],
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

      // Fn stands alone: nothing else on macOS claims a bare Fn tap, and the
      // host helper reports it over the hotkey bridge rather than as a key.
      if (modifiers.includes("function")) {
        selectActivator(FN_PTT_ACTIVATOR);
        return;
      }

      // Show the chord building as it is held. Whether it becomes a binding
      // depends on a real key arriving before the modifiers are released.
      if (MODIFIER_KEY_NAMES.has(event.key)) {
        setShowChordHint(false);
        setPendingModifiers(sortModifiers(modifiers));
        return;
      }

      if (modifiers.length === 0) {
        setShowChordHint(true);
        return;
      }

      selectActivator({
        kind: "key",
        label: event.key.length === 1 ? event.key.toUpperCase() : event.key,
        modifiers: sortModifiers(modifiers),
      });
    },
    [cancelRecording, collectModifiers, selectActivator],
  );

  const handleCaptureKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isRecording) {
        return;
      }
      // Every modifier released with no key pressed in between: the user tried
      // to bind a bare modifier. Stay open and say what is missing.
      const remaining = collectModifiers(event);
      if (remaining.length === 0 && pendingModifiers.length > 0) {
        setPendingModifiers([]);
        setShowChordHint(true);
      }
    },
    [collectModifiers, isRecording, pendingModifiers],
  );

  useEffect(() => {
    if (!isRecording) {
      return;
    }
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
    shortcutEnabled &&
    !presets.some((p) => activatorsEqual(p.activator, activator));

  if (desktopHost) {
    return (
      <DetailCard
        title={t("voicePage.voiceShortcutTitle")}
        subtitle={t("voicePage.voiceShortcutSubtitleDesktop")}
      >
        <div className="flex flex-col gap-2">
          {/* Both answers to "what starts Talk" are the same control, so
              neither reads as the primary one with the other bolted on. The
              write still goes to the host: Fn through the helper, a chord
              through `settings.hotkeys`. */}
          <div className="flex flex-wrap items-center gap-2">
            {fnConfigurable && (
              <ActivationKeyOption
                label={t("voicePage.fnKeyLabel")}
                badge={t("voicePage.recommendedBadge")}
                selected={isFnVoiceModeActivator(activator)}
                onClick={chooseFn}
              />
            )}
            {bareModifierPresets.map((preset) => (
              <ActivationKeyOption
                key={preset.label}
                label={preset.label}
                selected={activatorsEqual(preset.activator, activator)}
                onClick={() => chooseBareModifier(preset.activator)}
              />
            ))}
            <ActivationKeyOption
              label={
                recordingTalk ? (
                  t("voicePage.recordingPrompt")
                ) : talkAccelerator ? (
                  <ShortcutKeys accelerator={talkAccelerator} />
                ) : (
                  t("voicePage.customKey")
                )
              }
              selected={talkAccelerator !== ""}
              recording={recordingTalk}
              onClick={
                recordingTalk
                  ? recorder.stopRecording
                  : () => recorder.startRecording(TALK_HOTKEY_KEY)
              }
            />
            {/* A recorded chord also stores `off` locally (the chord itself
                lives in `settings.hotkeys`), so Off is only the selected
                answer when no chord is bound either. */}
            <ActivationKeyOption
              label={t("voicePage.offKeyLabel")}
              selected={
                activator.kind === "off" && !talkAccelerator && !recordingTalk
              }
              onClick={chooseOff}
            />
          </div>

          {/* An offer the host has already refused. Fn is presented as the
              recommended binding, so saying nothing would leave the user
              pressing a key that cannot fire. */}
          {isFnVoiceModeActivator(activator) && fnRefused && (
            <div className="flex items-start gap-1 pt-1 text-body-small-default text-[var(--system-negative-strong)]">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{t("voicePage.fnRefusedNote")}</span>
            </div>
          )}

          {recorder.conflict?.key === TALK_HOTKEY_KEY && (
            <div className="flex items-start gap-1 pt-1 text-body-small-default text-[var(--system-negative-strong)]">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                {t("voicePage.shortcutConflict", {
                  command: recorder.conflict.label,
                })}
              </span>
            </div>
          )}
        </div>
      </DetailCard>
    );
  }

  return (
    <DetailCard
      title={t("voicePage.voiceShortcutTitle")}
      subtitle={t("voicePage.voiceShortcutSubtitle")}
    >
      <div className="flex flex-col gap-4">
        <Toggle
          checked={shortcutEnabled}
          onChange={(next: boolean) => {
            selectActivator(
              next
                ? defaultVoiceModeActivator(fnConfigurable)
                : { kind: "off" },
            );
          }}
          label={t("voicePage.enableVoiceShortcut")}
        />

        {shortcutEnabled && (
          <div className="flex flex-col gap-2">
            <span className={labelClasses}>
              {t("voicePage.activationKeyLabel")}
            </span>
            <div
              ref={recordingZoneRef}
              tabIndex={isRecording ? 0 : -1}
              onKeyDown={isRecording ? handleCaptureKeyDown : undefined}
              onKeyUp={isRecording ? handleCaptureKeyUp : undefined}
              className="flex flex-wrap items-center gap-2 focus:outline-none"
            >
              {presets.map((preset) => (
                <ActivationKeyOption
                  key={preset.label}
                  label={preset.label}
                  selected={activatorsEqual(preset.activator, activator)}
                  onClick={() => selectActivator(preset.activator)}
                />
              ))}
              {isRecording ? (
                <ActivationKeyOption
                  label={
                    pendingModifiers.length > 0
                      ? modifierLabel(pendingModifiers)
                      : t("voicePage.pressShortcut")
                  }
                  selected
                  recording
                  onClick={cancelRecording}
                />
              ) : (
                <ActivationKeyOption
                  label={
                    isCustom
                      ? activatorDisplayName(activator)
                      : t("voicePage.customKey")
                  }
                  selected={isCustom}
                  onClick={beginRecording}
                />
              )}
            </div>

            {showChordHint && (
              <div className="flex items-start gap-1 pt-1 text-body-small-default text-[var(--content-quiet)]">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{t("voicePage.shortcutChordHint")}</span>
              </div>
            )}

            {shortcutEnabled && (
              <div className="flex items-start gap-1 pt-1 text-body-small-default text-[var(--content-quiet)]">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{t("voicePage.focusedTabNote")}</span>
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
  badge,
  selected,
  recording = false,
  onClick,
}: {
  label: ReactNode;
  /** Muted suffix inside the chip, e.g. marking the recommended option. */
  badge?: string;
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
      {badge && (
        <span className="text-body-small-default text-[var(--content-quiet)]">
          {badge}
        </span>
      )}
    </button>
  );
}

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
  const { t } = useTranslation("settings");
  const pauseMs = useVoicePrefsStore.use.pauseBeforeReplyMs();
  const setPauseMs = useVoicePrefsStore.use.setPauseBeforeReplyMs();
  const sensitivity = useVoicePrefsStore.use.interruptSensitivity();
  const setSensitivity = useVoicePrefsStore.use.setInterruptSensitivity();

  const interruptSensitivityItems = useMemo(
    () => [
      { value: "low" as const, label: t("voicePage.interruptSensitivityLow") },
      {
        value: "medium" as const,
        label: t("voicePage.interruptSensitivityMedium"),
      },
      {
        value: "high" as const,
        label: t("voicePage.interruptSensitivityHigh"),
      },
    ],
    [t],
  );

  const anySet = pauseMs !== null || sensitivity !== null;

  return (
    <DetailCard
      title={t("voicePage.turnTakingTitle")}
      subtitle={t("voicePage.turnTakingSubtitle")}
    >
      <div className="flex flex-col gap-5">
        <TuningRow
          label={t("voicePage.pauseBeforeReplyLabel")}
          description={t("voicePage.pauseBeforeReplyDescription")}
          isDefault={pauseMs === null}
        >
          <div className="max-w-xs">
            <Slider
              value={(pauseMs ?? DEFAULT_PAUSE_BEFORE_REPLY_MS) / 1000}
              onValueChange={(next) => {
                if (typeof next === "number") {
                  setPauseMs(Math.round(next * 1000));
                }
              }}
              min={MIN_PAUSE_BEFORE_REPLY_MS / 1000}
              max={MAX_PAUSE_BEFORE_REPLY_MS / 1000}
              step={0.1}
              showValue
              formatValue={(value) =>
                `${(typeof value === "number" ? value : value[0]).toFixed(1)}s`
              }
              aria-label={t("voicePage.pauseBeforeReplyAriaLabel")}
            />
          </div>
        </TuningRow>

        <TuningRow
          label={t("voicePage.interruptSensitivityLabel")}
          description={t("voicePage.interruptSensitivityDescription")}
          isDefault={sensitivity === null}
        >
          <div className="max-w-xs">
            <SegmentControl<InterruptSensitivity>
              items={interruptSensitivityItems}
              value={sensitivity ?? DEFAULT_INTERRUPT_SENSITIVITY}
              onChange={setSensitivity}
              ariaLabel={t("voicePage.interruptSensitivityAriaLabel")}
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
              {t("voicePage.resetToDefaults")}
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
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-body-medium-lighter text-[var(--content-default)]">
          {label}
        </span>
        {isDefault && (
          <span className="shrink-0 rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
            {t("voicePage.defaultBadge")}
          </span>
        )}
      </div>
      <p className={labelClasses}>{description}</p>
      {children}
    </div>
  );
}
