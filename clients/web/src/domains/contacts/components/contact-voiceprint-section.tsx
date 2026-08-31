/**
 * Voice profile enrollment for one contact.
 *
 * Record two clips, which are averaged into a single profile. Averaging
 * several is the cheapest accuracy win available, so the flow always
 * captures more than one.
 *
 * Enrollment only. Scoring a clip against every contact is a global
 * question ("who is speaking?"), not a per-contact one, so it does not
 * belong on a single contact's card.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { type Voiceprint } from "@/domains/contacts/voiceprints-gateway";
import { type Recorder, startRecording } from "@/domains/contacts/record-wav";
import { useTranslation } from "@/i18n";

/** Below this a clip is too short for a stable embedding. */
const MIN_SECONDS = 2;

/** Clips to capture per enrollment. Averaging several is the cheapest accuracy win. */
const ENROLL_CLIPS = 2;

interface ContactVoiceprintSectionProps {
  voiceprints: Voiceprint[];
  enrollPending: boolean;
  deletePending: boolean;
  onEnroll: (clips: Blob[]) => void;
  onDelete: (voiceprintId: string) => void;
}

type Phase = "idle" | "recording";

export function ContactVoiceprintSection({
  voiceprints,
  enrollPending,
  deletePending,
  onEnroll,
  onDelete,
}: ContactVoiceprintSectionProps) {
  const { t } = useTranslation("contacts");
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<Blob[]>([]);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const recorderRef = useRef<Recorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // A live mic must not outlive the view that opened it.
  useEffect(() => {
    return () => {
      stopTimer();
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, [stopTimer]);

  const profile = voiceprints[0] ?? null;
  const busy = enrollPending || deletePending;
  const inSequence = captured.length > 0;

  const begin = useCallback(async () => {
    setError(null);
    try {
      recorderRef.current = await startRecording();
    } catch {
      setError(t("voiceprint.micDenied"));
      return;
    }
    setPhase("recording");
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  }, [t]);

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) {
      return;
    }
    stopTimer();
    setPhase("idle");
    recorderRef.current = null;

    let clip: Blob;
    try {
      clip = await recorder.stop();
    } catch {
      setError(t("voiceprint.recordFailed"));
      return;
    }

    const clips = [...captured, clip];
    if (clips.length < ENROLL_CLIPS) {
      setCaptured(clips);
      return;
    }
    setCaptured([]);
    onEnroll(clips);
  }, [captured, onEnroll, stopTimer, t]);

  /**
   * Drop the in-flight recording without feeding it to the sequence.
   *
   * Stop is disabled until MIN_SECONDS, so without this a clip that caught
   * the wrong thing would have to be finished before it could be redone.
   */
  const cancelRecording = useCallback(() => {
    stopTimer();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setPhase("idle");
    setElapsed(0);
  }, [stopTimer]);

  /** Abandon a part-finished enrollment and return to the first clip. */
  const startOver = useCallback(() => {
    setCaptured([]);
    setError(null);
  }, []);

  const tooShort = elapsed < MIN_SECONDS;

  if (phase === "recording") {
    return (
      <div className="flex flex-col gap-3">
        <span className="text-sm tabular-nums">
          {t("voiceprint.recording", { seconds: elapsed })}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void finish()}
            disabled={tooShort}
          >
            {t("voiceprint.stop")}
          </Button>
          <Button type="button" variant="outlined" onClick={cancelRecording}>
            {t("actions.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {profile && !inSequence ? (
        <span className="text-sm">
          {t("voiceprint.enrolledFromClips", { count: profile.clipCount })}
        </span>
      ) : null}

      {inSequence ? (
        <span className="text-sm">
          {t("voiceprint.captured", {
            count: captured.length,
            total: ENROLL_CLIPS,
          })}
        </span>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {/* No re-record. Replacing a profile in place gave the card two
            competing actions and let an enrollment be overwritten by
            accident; deleting first makes the intent explicit. */}
        {!profile ? (
          <Button type="button" onClick={() => void begin()} disabled={busy}>
            {enrollPending
              ? t("voiceprint.enrolling")
              : inSequence
                ? t("voiceprint.enrollNext", {
                    index: captured.length + 1,
                    total: ENROLL_CLIPS,
                  })
                : t("voiceprint.record")}
          </Button>
        ) : null}

        {inSequence ? (
          <Button type="button" variant="outlined" onClick={startOver}>
            {t("voiceprint.startOver")}
          </Button>
        ) : null}

        {profile && !inSequence ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={busy}
          >
            {t("actions.delete")}
          </Button>
        ) : null}
      </div>

      {error ? <span className="text-sm text-red-600">{error}</span> : null}

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("voiceprint.deleteConfirmTitle")}
        message={t("voiceprint.deleteConfirmMessage")}
        confirmLabel={t("actions.delete")}
        destructive
        onConfirm={() => {
          setConfirmDeleteOpen(false);
          if (profile) {
            onDelete(profile.id);
          }
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
