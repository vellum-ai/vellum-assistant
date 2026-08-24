/**
 * On-demand preview of a managed voice via its hosted sample.
 *
 * Stands on its own because two unrelated surfaces audition voices: the voice
 * pickers, which preview a row of a list, and the onboarding face step, which
 * previews the one voice belonging to the centered avatar. Both need the same
 * teardown discipline, so it exists once.
 *
 * Hosted samples are static provider-side assets, so a preview costs no
 * synthesis and no credits. All a caller needs is the catalog.
 */

import { useEffect, useRef, useState } from "react";

import { toast } from "@vellumai/design-library/components/toast";

import { t } from "@/i18n";
import { type ManagedVoiceOption } from "@/lib/tts/use-managed-voices";

export interface UseVoiceSamplePreview {
  /** The model currently playing, or null. */
  previewingModel: string | null;
  play: (voice: ManagedVoiceOption) => void;
  stop: () => void;
}

/**
 * Tracks which voice is playing so a surface can swap its play affordance for
 * a stop one; tears down on a new play and on unmount so a late-resolving
 * `play()` can't leak onto a gone component.
 */
export function useVoiceSamplePreview(): UseVoiceSamplePreview {
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
    if (!voice.sampleUrl) {
      return;
    }
    audioRef.current?.pause();
    const token = ++tokenRef.current;
    const audio = new Audio(voice.sampleUrl);
    audioRef.current = audio;
    setPreviewingModel(voice.model);
    const clear = () => {
      if (tokenRef.current === token) {
        setPreviewingModel(null);
      }
    };
    audio.onended = clear;
    audio.onerror = clear;
    void audio.play().catch(() => {
      if (tokenRef.current === token) {
        toast.error(t("useVoiceSamplePreview.playFailed"));
        setPreviewingModel(null);
      }
    });
  }

  return { previewingModel, play, stop };
}
