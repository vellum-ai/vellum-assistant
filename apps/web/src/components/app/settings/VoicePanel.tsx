
import { ArrowUpRight, Info } from "lucide-react";
import { AppLink as Link } from "@/adapters/app-link.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Toggle } from "@vellum/design-library/components/toggle";
import {
  getLocalSetting,
  setLocalSetting,
} from "@/domains/settings/_lib/local-settings.js";
import {
  LS_PTT_ACTIVATION_KEY,
  activatorDisplayName,
  activatorsEqual,
  modifierLabel,
  parseActivator,
  serializeActivator,
  sortModifiers,
  type PTTActivator,
  type PTTModifier,
} from "@/lib/voice/ptt-activator.js";
import { routes } from "@/lib/routes.js";

const LS_CONVERSATION_TIMEOUT = "voice:conversationTimeoutSeconds";

// Browsers don't expose the Fn key as a KeyboardEvent, so the web port uses
// Ctrl/Alt/Shift-based presets instead of the macOS defaults (Fn, Fn+Shift).
const PTT_PRESETS: ReadonlyArray<{ label: string; activator: PTTActivator }> = [
  { label: "Ctrl", activator: { kind: "modifierOnly", modifiers: ["control"] } },
  { label: "Alt", activator: { kind: "modifierOnly", modifiers: ["option"] } },
  {
    label: "Ctrl+Shift",
    activator: { kind: "modifierOnly", modifiers: ["control", "shift"] },
  },
];

const CONVERSATION_TIMEOUT_OPTIONS = [
  { label: "5 seconds", value: "5" },
  { label: "10 seconds", value: "10" },
  { label: "15 seconds", value: "15" },
  { label: "30 seconds", value: "30" },
  { label: "60 seconds", value: "60" },
] as const;

type ConversationTimeoutValue =
  (typeof CONVERSATION_TIMEOUT_OPTIONS)[number]["value"];

const DEFAULT_CONVERSATION_TIMEOUT: ConversationTimeoutValue = "30";

const labelClasses =
  "text-body-small-default text-stone-600 dark:text-stone-300";

// ---------------------------------------------------------------------------
// VoicePanel
// ---------------------------------------------------------------------------

export function VoicePanel() {
  return (
    <div className="flex flex-col gap-6">
      <SpeechServicesBanner />
      <PushToTalkCard />
      <ConversationTimeoutCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Speech Services Info Banner
// ---------------------------------------------------------------------------

function SpeechServicesBanner() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-moss-600 dark:bg-moss-800">
      <Info className="h-3.5 w-3.5 shrink-0 text-forest-700" />
      <span className="text-body-medium-lighter text-stone-600 dark:text-stone-300">
        Looking to configure Speech-to-Text or Text-to-Speech models?
      </span>
      <Link
        href={routes.settings.ai}
        className="inline-flex items-center gap-1 text-body-medium-lighter text-forest-700 underline hover:text-forest-800 dark:text-forest-500 dark:hover:text-forest-400"
      >
        Go to Models &amp; Services
        <ArrowUpRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Push to Talk card
// ---------------------------------------------------------------------------

function PushToTalkCard() {
  const [activator, setActivator] = useState<PTTActivator>(() =>
    parseActivator(getLocalSetting(LS_PTT_ACTIVATION_KEY, "")),
  );
  const [isRecording, setIsRecording] = useState(false);
  const [pendingModifiers, setPendingModifiers] = useState<PTTModifier[]>([]);
  const recordingZoneRef = useRef<HTMLDivElement | null>(null);
  // Track whether a non-modifier key was pressed during capture so that a
  // keyup that would otherwise commit a modifier-only activator can be
  // suppressed (the key combo was already committed on keydown).
  const nonModifierPressedRef = useRef(false);

  const pttEnabled = activator.kind !== "off";

  const selectActivator = useCallback((next: PTTActivator) => {
    setActivator(next);
    setLocalSetting(LS_PTT_ACTIVATION_KEY, serializeActivator(next));
    setIsRecording(false);
    setPendingModifiers([]);
    // NOTE: do not reset `nonModifierPressedRef` here — commit paths
    // (keydown + non-modifier key) rely on the flag staying true through
    // the subsequent keyup so the modifier-only fallback in
    // `handleCaptureKeyUp` does not double-commit. The flag is reset when a
    // new recording session starts (see `beginRecording` / `cancelRecording`).
  }, []);

  const beginRecording = useCallback(() => {
    setIsRecording(true);
    setPendingModifiers([]);
    nonModifierPressedRef.current = false;
    // Focus the capture zone so it receives keydown events.
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
    [],
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
        // Defer committing modifier-only activators until keyup so users can
        // naturally compose key combos (e.g. Ctrl+K) even when the modifier
        // is pressed first. `pendingModifiers` drives the UI preview.
        setPendingModifiers(sortModifiers(modifiers));
        return;
      }

      // A non-modifier key commits the combo immediately.
      nonModifierPressedRef.current = true;
      const label = key.length === 1 ? key.toUpperCase() : key;
      selectActivator({ kind: "key", label, modifiers });
    },
    [cancelRecording, collectModifiers, selectActivator],
  );

  const handleCaptureKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isRecording) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const key = event.key;
      const isModifierOnly =
        key === "Control" ||
        key === "Alt" ||
        key === "Shift" ||
        key === "Meta" ||
        key === "Fn";
      if (!isModifierOnly) {
        return;
      }

      // Only commit a modifier-only activator if the user never pressed a
      // non-modifier key during this capture (otherwise the combo already
      // committed on keydown).
      if (nonModifierPressedRef.current) {
        nonModifierPressedRef.current = false;
        setPendingModifiers([]);
        return;
      }

      const remaining = collectModifiers(event);
      // On the final keyup for this combo, commit the full set of modifiers
      // the user was holding (taken from our tracked `pendingModifiers`).
      if (remaining.length === 0 && pendingModifiers.length > 0) {
        selectActivator({
          kind: "modifierOnly",
          modifiers: pendingModifiers,
        });
      }
    },
    [collectModifiers, isRecording, pendingModifiers, selectActivator],
  );

  // If the user clicks outside the capture zone while recording, stop.
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
    pttEnabled &&
    !PTT_PRESETS.some((p) => activatorsEqual(p.activator, activator));

  return (
    <SettingsCard
      title="Push to Talk"
      subtitle="Hold the activation key to dictate text or start a voice conversation."
    >
      <div className="flex flex-col gap-4">
        <Toggle
          checked={pttEnabled}
          onChange={(next: boolean) => {
            if (next) {
              if (activator.kind === "off") {
                selectActivator({
                  kind: "modifierOnly",
                  modifiers: ["control"],
                });
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
              {PTT_PRESETS.map((preset) => {
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

            <div className="flex items-start gap-1 pt-1 text-body-small-default text-stone-500 dark:text-stone-400">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                Push-to-Talk only works while this tab is focused, and
                browsers may intercept some shortcuts (e.g. Ctrl+T) before
                the page can see them. For always-on PTT, use the Vellum
                desktop app.
              </span>
            </div>
          </div>
        )}
      </div>
    </SettingsCard>
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
    "border-stone-200 dark:border-moss-600",
    selected
      ? "bg-stone-100 dark:bg-moss-700"
      : "bg-white hover:bg-stone-50 dark:bg-moss-800 dark:hover:bg-moss-700",
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
            ? "border-forest-700 bg-forest-700"
            : "border-stone-300 dark:border-moss-500",
        ].join(" ")}
      />
      <span className="text-stone-900 dark:text-white">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Conversation Timeout card
// ---------------------------------------------------------------------------

function ConversationTimeoutCard() {
  const [timeout, setTimeoutValue] = useState<ConversationTimeoutValue>(() => {
    const raw = getLocalSetting(
      LS_CONVERSATION_TIMEOUT,
      DEFAULT_CONVERSATION_TIMEOUT,
    );
    const match = CONVERSATION_TIMEOUT_OPTIONS.find((o) => o.value === raw);
    return (match?.value ?? DEFAULT_CONVERSATION_TIMEOUT);
  });

  const handleChange = useCallback((next: ConversationTimeoutValue) => {
    setTimeoutValue(next);
    setLocalSetting(LS_CONVERSATION_TIMEOUT, next);
  }, []);

  return (
    <SettingsCard
      title="Conversation Timeout"
      subtitle="How long the assistant waits for you to start speaking before ending a voice conversation turn."
    >
      <div className="max-w-xs">
        <Dropdown<ConversationTimeoutValue>
          options={CONVERSATION_TIMEOUT_OPTIONS}
          value={timeout}
          onChange={handleChange}
          aria-label="Conversation timeout"
        />
      </div>
    </SettingsCard>
  );
}
