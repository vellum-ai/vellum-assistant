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
 * its own name) — with a per-row preview button and a check on the current
 * selection. The upstream provider ("ElevenLabs", "Deepgram") is shown as a
 * quiet badge only when `showSource` is set (the settings surfaces); the
 * first-run onboarding card leaves it off.
 *
 * Selecting a voice writes it to daemon config via
 * {@link useManagedVoiceSelection}, which hot-applies on the assistant's next
 * spoken turn. Renders nothing unless managed voice selection is available.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Check, Square, Volume2 } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { toast } from "@vellumai/design-library/components/toast";

import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import {
  groupVoicesByAccent,
  MANAGED_VOICE_SOURCE_LABELS,
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
  /**
   * Controlled mode. Pass both to let the parent own the selection — the list
   * calls `onChange` instead of writing to daemon config, so a batched form
   * (Models & Services) can hold the pick in a draft until Save. Omit both and
   * the list self-commits via {@link useManagedVoiceSelection} (instant
   * hot-apply — the voice room and Voice settings picker).
   */
  value?: string;
  onChange?: (model: string) => void;
  /**
   * Show each voice's upstream provider (e.g. "ElevenLabs") as a quiet badge.
   * On for the settings surfaces; off (default) keeps the first-run onboarding
   * card free of provider jargon.
   */
  showSource?: boolean;
  /**
   * Add a provider dropdown above the list that scopes it to one upstream
   * source (ElevenLabs, Deepgram, …), grouped by accent within that choice —
   * the Voice-page picker modal. When on, the per-row source badge is dropped
   * (the chosen provider already labels the whole list) and the list gets more
   * height. The dropdown hides itself when the catalog has a single provider.
   */
  filterBySource?: boolean;
}

export function VoiceList({
  assistantId,
  heading,
  className,
  onSelect,
  value,
  onChange,
  showSource = false,
  filterBySource = false,
}: VoiceListProps) {
  const {
    available,
    voices,
    currentModel,
    defaultModel,
    selectModel,
    selecting,
  } = useManagedVoiceSelection(assistantId);

  // Controlled when the parent supplies both value and onChange; otherwise the
  // list owns selection and commits instantly.
  const controlled = value !== undefined && onChange !== undefined;
  const activeModel = controlled ? value : currentModel;
  const choose = (model: string) => {
    if (controlled) onChange(model);
    else selectModel(model);
    onSelect?.();
  };

  // Provider filter (Voice-page modal): a dropdown scopes the list to one
  // upstream source so accent grouping isn't split across providers. Sources are
  // ordered by their display label for a stable dropdown.
  const sources = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const v of voices) {
      if (!seen.has(v.source)) {
        seen.add(v.source);
        ordered.push(v.source);
      }
    }
    return ordered.sort((a, b) =>
      (MANAGED_VOICE_SOURCE_LABELS[a] ?? a).localeCompare(
        MANAGED_VOICE_SOURCE_LABELS[b] ?? b,
      ),
    );
  }, [voices]);
  const [sourceOverride, setSourceOverride] = useState<string | null>(null);
  const activeVoiceSource = voices.find((v) => v.model === activeModel)?.source;
  // Default to the current voice's provider so the modal opens on the group it
  // lives in; the user's own pick then wins.
  const selectedSource = filterBySource
    ? (sourceOverride ?? activeVoiceSource ?? sources[0] ?? null)
    : null;
  const showSourceFilter = filterBySource && sources.length > 1;

  const groups = useMemo(
    () =>
      groupVoicesByAccent(
        selectedSource
          ? voices.filter((v) => v.source === selectedSource)
          : voices,
      ),
    [voices, selectedSource],
  );
  const { previewingModel, play, stop } = useVoiceSamplePreview();

  // Bring the current voice into view on open — grouping means it may sit in a
  // lower section rather than at the top.
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // `?.` on the method too — not every environment implements scrollIntoView.
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  // Render nothing when there's no catalog, so the surrounding chrome collapses
  // with it. Uncontrolled surfaces also require the assistant to be managed
  // (`available`); a controlled parent (the Text-to-Speech card) owns that
  // decision via its own draft provider, so gate only on having voices —
  // otherwise switching the draft provider to Vellum would show an empty picker
  // until the first Save persists the provider.
  const hasCatalog = voices.length > 0;
  if (controlled ? !hasCatalog : !available) return null;

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
      {showSourceFilter && (
        <div className="px-1 pb-1">
          <Dropdown
            value={selectedSource ?? ""}
            onChange={setSourceOverride}
            options={sources.map((s) => ({
              value: s,
              label: MANAGED_VOICE_SOURCE_LABELS[s] ?? s,
            }))}
            aria-label="Voice provider"
          />
        </div>
      )}
      <div
        role="listbox"
        aria-label="Assistant voice"
        className={cn(
          "flex flex-col overflow-y-auto",
          filterBySource ? "max-h-[60vh]" : "max-h-80",
          selecting && "pointer-events-none opacity-70",
        )}
      >
        {groups.map((group) => (
          <div key={group.accent} role="group" aria-label={group.accent}>
            <div className="px-3 pb-1 pt-3 text-label-small-default text-[var(--content-tertiary)]">
              {group.accent}
            </div>
            {group.voices.map((voice) => {
              const isSelected = voice.model === activeModel;
              const isPreviewing = previewingModel === voice.model;
              const isDefault = voice.model === defaultModel;
              return (
                <div
                  key={voice.model}
                  ref={isSelected ? selectedRef : undefined}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => choose(voice.model)}
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
                    {isDefault && (
                      <span className="text-[var(--content-tertiary)]">
                        {" "}
                        (default)
                      </span>
                    )}
                  </span>
                  {showSource && !filterBySource && (
                    <span className="shrink-0 text-body-small-default text-[var(--content-tertiary)]">
                      {MANAGED_VOICE_SOURCE_LABELS[voice.source] ?? voice.source}
                    </span>
                  )}
                  {/* One fixed-width trailing slot the preview button and the
                      selected-check share, so the provider badge never shifts
                      between rows. At rest: the check on the selected row, empty
                      otherwise. On hover/focus (or while previewing) the speaker
                      takes over — so the selected row is previewable too. */}
                  <div className="relative flex size-7 shrink-0 items-center justify-center">
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
                        className={cn(
                          "absolute inset-0 transition-opacity",
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
                        className={cn(
                          "pointer-events-none size-4 text-[var(--system-positive-strong)] transition-opacity",
                          // Hide the check whenever the speaker is showing (hover
                          // /focus or previewing), so they never stack.
                          isPreviewing
                            ? "opacity-0"
                            : voice.sampleUrl !== ""
                              ? "opacity-100 group-hover:opacity-0 group-focus-within:opacity-0"
                              : "opacity-100",
                        )}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
