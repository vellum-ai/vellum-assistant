/**
 * Voice profile management for one contact.
 *
 * Record a few seconds, enroll, and afterward check a fresh clip
 * against every enrolled contact to see who the assistant thinks
 * is speaking.
 *
 * The score is shown because it is the honest output: this
 * recognizes a voice, it does not verify an identity, and nothing
 * here grants access.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";

import { useTranslation } from "@/i18n";
import {
  type IdentifyResult,
  type Voiceprint,
} from "@/domains/contacts/voiceprints-gateway";
import { type Recorder, startRecording } from "@/domains/contacts/record-wav";

/** Below this a clip is too short for a stable embedding. */
const MIN_SECONDS = 2;

/** Clips to capture per enrollment. Averaging several is the cheapest accuracy win. */
const ENROLL_CLIPS = 2;

interface ContactVoiceprintSectionProps {
  voiceprints: Voiceprint[];
  enrollPending: boolean;
  deletePending: boolean;
  identifyPending: boolean;
  identifyResult: IdentifyResult | null;
  contactId: string;
  onEnroll: (clips: Blob[]) => void;
  onDelete: (voiceprintId: string) => void;
  onIdentify: (clip: Blob) => void;
  onClearIdentify: () => void;
}

type Phase = "idle" | "recording";

export function ContactVoiceprintSection({
  voiceprints,
  enrollPending,
  deletePending,
  identifyPending,
  identifyResult,
  contactId,
  onEnroll,
  onDelete,
  onIdentify,
  onClearIdentify,
}: ContactVoiceprintSectionProps) {
  const { t } = useTranslation("contacts");
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Which flow the in-flight recording feeds once stopped.
  const [intent, setIntent] = useState<"enroll" | "identify">("enroll");
  const [captured, setCaptured] = useState<Blob[]>([]);

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
  const busy = enrollPending || deletePending || identifyPending;

  const begin = useCallback(
    async (nextIntent: "enroll" | "identify") => {
      setError(null);
      onClearIdentify();
      setIntent(nextIntent);
      // Reset only when leaving the enroll flow. Clearing on every enroll
      // press would discard the clip just recorded, so the sequence could
      // never reach its last clip.
      if (nextIntent === "identify") {
        setCaptured([]);
      }
      try {
        recorderRef.current = await startRecording();
      } catch {
        setError(t("voiceprint.micDenied"));
        return;
      }
      setPhase("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    },
    [onClearIdentify, t],
  );

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

    if (intent === "identify") {
      onIdentify(clip);
      return;
    }

    const clips = [...captured, clip];
    if (clips.length < ENROLL_CLIPS) {
      setCaptured(clips);
      return;
    }
    setCaptured([]);
    onEnroll(clips);
  }, [captured, intent, onEnroll, onIdentify, stopTimer, t]);

  const tooShort = elapsed < MIN_SECONDS;

  return (
    <div className="flex flex-col gap-3">
      {profile ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">
            {t("voiceprint.enrolledFromClips", { count: profile.clipCount })}
          </span>
          <Button
            type="button"
            variant="danger"
            onClick={() => onDelete(profile.id)}
            disabled={busy || phase === "recording"}
          >
            {t("actions.delete")}
          </Button>
        </div>
      ) : null}

      {phase === "recording" ? (
        <div className="flex items-center gap-3">
          <span className="text-sm tabular-nums">
            {t("voiceprint.recording", { seconds: elapsed })}
          </span>
          <Button
            type="button"
            onClick={() => void finish()}
            disabled={tooShort}
          >
            {t("voiceprint.stop")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void begin("enroll")}
            disabled={busy}
          >
            {enrollPending
              ? t("voiceprint.enrolling")
              : captured.length > 0
                ? t("voiceprint.enrollNext", {
                    index: captured.length + 1,
                    total: ENROLL_CLIPS,
                  })
                : profile
                  ? t("voiceprint.reenroll")
                  : t("voiceprint.enroll")}
          </Button>
          {voiceprints.length > 0 ? (
            <Button
              type="button"
              variant="outlined"
              onClick={() => void begin("identify")}
              disabled={busy}
            >
              {identifyPending
                ? t("voiceprint.checking")
                : t("voiceprint.check")}
            </Button>
          ) : null}
        </div>
      )}

      {error ? <span className="text-sm text-red-600">{error}</span> : null}

      {identifyResult ? (
        <IdentifyReadout result={identifyResult} contactId={contactId} />
      ) : null}
    </div>
  );
}

function IdentifyReadout({
  result,
  contactId,
}: {
  result: IdentifyResult;
  contactId: string;
}) {
  const { t } = useTranslation("contacts");
  const best = result.best;

  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <span className="text-sm font-medium">
        {best
          ? t("voiceprint.bestMatch", {
              name: best.displayName,
              score: best.score.toFixed(3),
            })
          : t("voiceprint.noMatch", { threshold: result.threshold.toFixed(2) })}
      </span>
      {/* Every score, so a wrong-but-confident match is visible rather
          than hidden behind the winner. */}
      {result.ranked.map((match) => (
        <span
          key={match.voiceprintId}
          className={
            match.contactId === contactId ? "text-sm font-medium" : "text-sm"
          }
        >
          {match.displayName} {match.score.toFixed(3)}
        </span>
      ))}
    </div>
  );
}
