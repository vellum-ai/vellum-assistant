/**
 * The pickers the call bar's chevrons open in the companion's popover: which
 * microphone the call listens through, and which voice the assistant speaks
 * in. The voice list follows Settings: grouped by accent, each voice named by
 * its traits, with a preview of its hosted sample.
 *
 * Presentational, like the rest of the popover: the window holding the call
 * fills them and takes the pick.
 */

import { Check, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  CompanionPopover,
  CompanionPopoverAnswer,
} from "@vellumai/ipc-contract";
import { Button } from "@vellumai/design-library/components/button";
import { ScrollShadow } from "@vellumai/design-library/components/scroll-shadow";

import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

type Answer = (answer: CompanionPopoverAnswer) => void;

function PickerRow({
  label,
  selected,
  onPick,
  trailing,
}: {
  label: ReactNode;
  selected: boolean;
  onPick: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      className={cn(
        "flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 transition-colors",
        selected
          ? "bg-[var(--surface-active)]"
          : "hover:bg-[var(--surface-hover)]",
      )}
      onClick={onPick}
    >
      <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
        {label}
      </span>
      {trailing}
      {selected ? (
        <Check
          aria-hidden
          className="size-4 shrink-0 text-[var(--system-positive-strong)]"
        />
      ) : (
        <span aria-hidden className="size-4 shrink-0" />
      )}
    </div>
  );
}

function PickerList({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <ScrollShadow
      className="-mx-2 min-h-0 flex-1"
      size={20}
      fadeEdges="end"
      hideScrollBar
    >
      <div role="listbox" aria-label={label} className="flex flex-col">
        {children}
      </div>
    </ScrollShadow>
  );
}

export function MicrophonePicker({
  popover,
  onAnswer,
}: {
  popover: Extract<CompanionPopover, { kind: "microphones" }>;
  onAnswer?: Answer;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PickerList label={t("companionPopover.microphoneTitle")}>
        <PickerRow
          label={t("companionPopover.systemDefault")}
          selected={popover.selected === ""}
          onPick={() => onAnswer?.({ kind: "pick", optionId: "" })}
        />
        {popover.options.map((option) => (
          <PickerRow
            key={option.id}
            label={option.label}
            selected={popover.selected === option.id}
            onPick={() => onAnswer?.({ kind: "pick", optionId: option.id })}
          />
        ))}
      </PickerList>
      {popover.needsPermission ? (
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {t("companionPopover.microphonePermissionHint")}
        </p>
      ) : null}
    </>
  );
}

/**
 * Plays one voice's hosted sample at a time, and stops it when the picker
 * goes away.
 */
function useSamplePreview() {
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const stop = (): void => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };

  const play = (id: string, url: string): void => {
    audioRef.current?.pause();
    const audio = new Audio(url);
    audioRef.current = audio;
    setPlaying(id);
    const clear = (): void => {
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPlaying(null);
      }
    };
    audio.onended = clear;
    audio.onerror = clear;
    void audio.play().catch(clear);
  };

  return { playing, play, stop };
}

export function VoicePicker({
  popover,
  onAnswer,
}: {
  popover: Extract<CompanionPopover, { kind: "voices" }>;
  onAnswer?: Answer;
}) {
  const { t } = useTranslation();
  const { playing, play, stop } = useSamplePreview();
  return (
    <PickerList label={t("companionPopover.voiceTitle")}>
      {popover.groups.map((group) => (
        <div key={group.accent} role="group" aria-label={group.accent}>
          <div className="px-3 pt-3 pb-1 text-label-small-default text-[var(--content-tertiary)]">
            {group.accent}
          </div>
          {group.voices.map((voice) => {
            const previewing = playing === voice.id;
            return (
              <PickerRow
                key={voice.id}
                label={
                  voice.isDefault ? (
                    <>
                      {voice.label}
                      <span className="text-[var(--content-tertiary)]">
                        {` ${t("companionPopover.defaultSuffix")}`}
                      </span>
                    </>
                  ) : (
                    voice.label
                  )
                }
                selected={popover.selected === voice.id}
                onPick={() => onAnswer?.({ kind: "pick", optionId: voice.id })}
                trailing={
                  voice.sampleUrl !== "" ? (
                    <Button
                      variant="ghost"
                      size="compact"
                      className="size-7 shrink-0"
                      iconOnly={previewing ? <Square /> : <Volume2 />}
                      aria-label={
                        previewing
                          ? t("companionPopover.stopPreview")
                          : t("companionPopover.previewVoice", {
                              voice: voice.label,
                            })
                      }
                      onClick={(event) => {
                        // Preview only; the row's pick stays unpressed.
                        event.stopPropagation();
                        if (previewing) {
                          stop();
                        } else {
                          play(voice.id, voice.sampleUrl);
                        }
                      }}
                    />
                  ) : undefined
                }
              />
            );
          })}
        </div>
      ))}
    </PickerList>
  );
}
