/**
 * The selectable list of managed (Vellum) voices, shared by every surface that
 * offers a voice: the live-voice first-run card (which renders it as one of its
 * own views), the voice-room settings popover (via `VoicePickerModal`), and the
 * Voice settings page (which renders it inline, having the room for it).
 *
 * Lives under `components/speech/` — alongside the shared TTS/STT provider
 * forms — because both the `chat` and `settings` domains render it, and domains
 * don't import from each other.
 *
 * Each row shows the voice's short character description (e.g.
 * "American · warm, clear") — NOT the catalog's proper name (the assistant has
 * its own name) and NOT the upstream source — with a per-row preview button and
 * a check on the current selection.
 *
 * Selecting a voice writes it to daemon config via
 * {@link useManagedVoiceSelection}, which hot-applies on the assistant's next
 * spoken turn. Renders nothing unless managed voice selection is available.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Check, Square, Volume2 } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import {
  groupVoicesByAccent,
  splitVoiceDescription,
  voiceTraitsLabel,
} from "@/lib/tts/managed-voice-catalog";
import { type ManagedVoiceOption } from "@/lib/tts/use-managed-voices";

/**
 * A voice's label: its character traits lead (sentence-cased), with the accent
 * as a quieter suffix. No proper name (the assistant has its own) and no
 * upstream source. Truncates to one line; pass `className` (with `min-w-0
 * flex-1`) to make it the truncating flex child of a row.
 */
export function VoiceLabel({
  description,
  className,
}: {
  description: string;
  className?: string;
}) {
  const { accent } = splitVoiceDescription(description);
  return (
    <span className={cn("truncate", className)}>
      {voiceTraitsLabel(description)}
      {accent && (
        <span className="text-[var(--content-tertiary)]">{` · ${accent}`}</span>
      )}
    </span>
  );
}

/**
 * On-demand preview of a single voice via its hosted sample. Tracks which
 * voice is playing so the row can show a spinner; tears down on a new play and
 * on unmount so a late-resolving `play()` can't leak onto a gone component.
 */
function useVoiceSamplePreview(): {
  previewingModel: string | null;
  play: (voice: ManagedVoiceOption) => void;
  stop: () => void;
} {
  const [previewingModel, setPreviewingModel] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tokenRef = useRef(0);

  const stop = () => {
    // Bump the token so a late-resolving play() bails, then tear down.
    tokenRef.current++;
    audioRef.current?.pause();
    audioRef.current = null;
    setPreviewingModel(null);
  };

  useEffect(
    () => () => {
      tokenRef.current++;
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  function play(voice: ManagedVoiceOption): void {
    if (!voice.sampleUrl) return;
    audioRef.current?.pause();
    const token = ++tokenRef.current;
    const audio = new Audio(voice.sampleUrl);
    audioRef.current = audio;
    setPreviewingModel(voice.model);
    const clear = () => {
      if (tokenRef.current === token) setPreviewingModel(null);
    };
    audio.onended = clear;
    audio.onerror = clear;
    void audio.play().catch(() => {
      if (tokenRef.current === token) {
        toast.error("Could not play the voice sample.");
        setPreviewingModel(null);
      }
    });
  }

  return { previewingModel, play, stop };
}

export interface VoiceListProps {
  /** Assistant whose voice is being chosen / auditioned. */
  assistantId: string | null;
  /** Optional section heading (shown above the list, with a top divider). */
  heading?: string;
  className?: string;
  /** Called after a voice is chosen — e.g. to close the picker modal. */
  onSelect?: () => void;
}

export function VoiceList({
  assistantId,
  heading,
  className,
  onSelect,
}: VoiceListProps) {
  const { available, voices, currentModel, selectModel, selecting } =
    useManagedVoiceSelection(assistantId);

  const groups = useMemo(() => groupVoicesByAccent(voices), [voices]);
  const { previewingModel, play, stop } = useVoiceSamplePreview();

  // Bring the current voice into view on open — grouping means it may sit in a
  // lower section rather than at the top.
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // `?.` on the method too — not every environment implements scrollIntoView.
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  // Nothing to offer (BYO provider, old daemon, empty catalog) — render no
  // list at all, so the surrounding section chrome collapses with it.
  if (!available) return null;

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        heading && "border-t border-[var(--border-subtle)] pt-3",
        className,
      )}
    >
      {heading && (
        <span className="text-label-medium-default text-[var(--content-secondary)]">
          {heading}
        </span>
      )}
      <div
        role="listbox"
        aria-label="Assistant voice"
        className={cn(
          "flex max-h-80 flex-col overflow-y-auto",
          selecting && "pointer-events-none opacity-70",
        )}
      >
        {groups.map((group) => (
          <div key={group.accent} role="group" aria-label={group.accent}>
            <div className="px-3 pb-1 pt-3 text-label-small-default text-[var(--content-tertiary)]">
              {group.accent}
            </div>
            {group.voices.map((voice) => {
              const isSelected = voice.model === currentModel;
              const isPreviewing = previewingModel === voice.model;
              return (
                <div
                  key={voice.model}
                  ref={isSelected ? selectedRef : undefined}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    selectModel(voice.model);
                    onSelect?.();
                  }}
                  className={cn(
                    "group flex cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 transition-colors",
                    // Selected reads as a soft persistent fill + a trailing
                    // check — not a form-field border.
                    isSelected
                      ? "bg-[var(--surface-active)]"
                      : "hover:bg-[var(--surface-hover)]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
                    {voiceTraitsLabel(voice.description)}
                  </span>
                  {voice.sampleUrl !== "" && (
                    <Button
                      variant="ghost"
                      size="compact"
                      iconOnly={isPreviewing ? <Square /> : <Volume2 />}
                      aria-label={
                        isPreviewing
                          ? "Stop preview"
                          : `Preview ${voice.description}`
                      }
                      // Quiet affordance: revealed on row hover / keyboard focus
                      // (and kept visible while previewing). On touch devices —
                      // which have no hover — it stays visible so preview is
                      // always reachable.
                      className={cn(
                        "shrink-0 transition-opacity",
                        isPreviewing
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch-mobile:opacity-100",
                      )}
                      // Preview / stop only — don't let the row's select fire.
                      onClick={(event) => {
                        event.stopPropagation();
                        if (isPreviewing) {
                          stop();
                        } else {
                          play(voice);
                        }
                      }}
                    />
                  )}
                  {isSelected && (
                    <Check
                      aria-hidden
                      className="size-4 shrink-0 text-[var(--system-positive-strong)]"
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
