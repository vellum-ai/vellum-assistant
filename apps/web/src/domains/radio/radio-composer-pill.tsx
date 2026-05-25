import {
  ChevronUp,
  Mic2,
  Music,
  Pause,
  Play,
  Radio,
  Settings,
  SkipForward,
  X,
} from "lucide-react";
import { useCallback } from "react";
import { useNavigate } from "react-router";

import { Button, Popover } from "@vellum/design-library";

import { useRadioStore } from "@/domains/radio/radio-store.js";
import type { RadioDisplayCue, RadioStatus } from "@/domains/radio/types.js";
import { routes } from "@/utils/routes.js";

export interface RadioComposerPillProps {
  assistantId: string;
}

function formatCountdown(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function cueLabel(cue: RadioDisplayCue | null, status: RadioStatus): string {
  if (status === "setup_needed" || cue === "setup_needed") return "Setup";
  if (status === "transitioning" || cue === "transition") return "Transition";
  if (cue === "song") return "Song";
  if (cue === "dj") return "DJ";
  return "Off";
}

function cueIcon(cue: RadioDisplayCue | null, status: RadioStatus) {
  const label = cueLabel(cue, status);
  if (label === "Song") return Music;
  if (label === "DJ" || label === "Transition") return Mic2;
  return Radio;
}

function statusText(status: RadioStatus): string {
  if (status === "loading") return "Starting radio";
  if (status === "paused") return "Paused";
  if (status === "error") return "Radio unavailable";
  return "On Air";
}

export function RadioComposerPill({ assistantId }: RadioComposerPillProps) {
  const navigate = useNavigate();
  const stationAssistantId = useRadioStore.use.assistantId();
  const status = useRadioStore.use.status();
  const displayCue = useRadioStore.use.displayCue();
  const isExpanded = useRadioStore.use.isExpanded();
  const isHidden = useRadioStore.use.isHidden();
  const currentTrack = useRadioStore.use.currentTrack();
  const nextTrack = useRadioStore.use.nextTrack();
  const djText = useRadioStore.use.djText();
  const progressMs = useRadioStore.use.progressMs();
  const remainingMs = useRadioStore.use.remainingMs();
  const setup = useRadioStore.use.setup();
  const errorMessage = useRadioStore.use.errorMessage();
  const start = useRadioStore.use.start();
  const pause = useRadioStore.use.pause();
  const resume = useRadioStore.use.resume();
  const skip = useRadioStore.use.skip();
  const setExpanded = useRadioStore.use.setExpanded();
  const hide = useRadioStore.use.hide();
  const show = useRadioStore.use.show();

  const isCurrentAssistant =
    stationAssistantId === null || stationAssistantId === assistantId;
  const scopedStatus = isCurrentAssistant ? status : "idle";
  const scopedDisplayCue = isCurrentAssistant ? displayCue : null;
  const scopedCurrentTrack = isCurrentAssistant ? currentTrack : null;
  const scopedNextTrack = isCurrentAssistant ? nextTrack : null;
  const scopedDjText = isCurrentAssistant ? djText : null;
  const scopedProgressMs = isCurrentAssistant ? progressMs : 0;
  const scopedRemainingMs = isCurrentAssistant ? remainingMs : 0;
  const scopedSetup = isCurrentAssistant ? setup : null;
  const scopedErrorMessage = isCurrentAssistant ? errorMessage : null;

  const label = cueLabel(scopedDisplayCue, scopedStatus);
  const CueIcon = cueIcon(scopedDisplayCue, scopedStatus);
  const countdown = formatCountdown(scopedRemainingMs);
  const trackDurationMs = scopedCurrentTrack?.durationMs ?? 0;
  const progressPercent =
    trackDurationMs > 0
      ? Math.max(0, Math.min(100, Math.round((scopedProgressMs / trackDurationMs) * 100)))
      : 0;
  const isPaused = scopedStatus === "paused";
  const canResume = isPaused;
  const canPause = scopedStatus === "playing" || scopedStatus === "transitioning";
  const setupNeeded = scopedStatus === "setup_needed" || !!scopedSetup;

  const handlePrimaryPlayback = useCallback(() => {
    if (canResume) {
      void resume();
      return;
    }
    if (canPause) {
      pause();
      return;
    }
    void start(assistantId);
  }, [assistantId, canPause, canResume, pause, resume, start]);

  const handleSkip = useCallback(() => {
    void skip(assistantId);
  }, [assistantId, skip]);

  const handleSettings = useCallback(() => {
    navigate(routes.settings.ai);
  }, [navigate]);

  if (isHidden) {
    return (
      <Button
        variant="ghost"
        size="compact"
        iconOnly={<Radio className="h-3.5 w-3.5" />}
        aria-label="Show radio"
        onClick={show}
      />
    );
  }

  return (
    <Popover.Root open={isExpanded} onOpenChange={setExpanded}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="compact"
          active={
            isExpanded ||
            scopedStatus === "playing" ||
            scopedStatus === "transitioning"
          }
          leftIcon={<CueIcon className="h-3.5 w-3.5 shrink-0" />}
          className="max-w-[180px] rounded-full px-2"
          tintColor="var(--content-default)"
          aria-label="Open radio controls"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-[11px] font-medium">
              {statusText(scopedStatus)}
            </span>
            <span className="truncate text-[11px] text-[var(--content-tertiary)]">
              {label}
            </span>
            {countdown ? (
              <span className="min-w-[4ch] shrink-0 text-right text-[11px] tabular-nums text-[var(--content-tertiary)]">
                {countdown}
              </span>
            ) : null}
            <ChevronUp className="h-3 w-3 shrink-0 text-[var(--content-tertiary)]" />
          </span>
        </Button>
      </Popover.Trigger>
      <Popover.Content
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 p-0"
      >
        <div className="space-y-3 p-3">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 rounded-full bg-[var(--surface-muted)] p-1.5 text-[var(--content-default)]">
              <CueIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-[var(--content-default)]">
                  {scopedCurrentTrack?.title ??
                    (setupNeeded ? "Radio setup needed" : "Radio")}
                </p>
                <span className="shrink-0 text-[11px] text-[var(--content-tertiary)]">
                  {label}
                </span>
              </div>
              {scopedCurrentTrack?.artist ? (
                <p className="truncate text-xs text-[var(--content-tertiary)]">
                  {scopedCurrentTrack.artist}
                </p>
              ) : null}
            </div>
          </div>

          {scopedNextTrack ? (
            <p className="truncate text-xs text-[var(--content-secondary)]">
              Next: {scopedNextTrack.title}
            </p>
          ) : null}

          <div
            role="progressbar"
            aria-label="Radio progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
            className="h-1.5 overflow-hidden rounded-full bg-[var(--border-subtle)]"
          >
            <div
              className="h-full rounded-full bg-[var(--content-default)]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {scopedDjText ? (
            <p className="line-clamp-3 text-xs text-[var(--content-secondary)]">
              {scopedDjText}
            </p>
          ) : null}

          {setupNeeded ? (
            <div className="space-y-2 rounded-[8px] bg-[var(--surface-muted)] p-2">
              <p className="text-xs text-[var(--content-secondary)]">
                {scopedSetup?.message ??
                  "Configure Text-to-Speech to use radio DJ breaks."}
              </p>
              <Button
                variant="outlined"
                size="compact"
                leftIcon={<Settings className="h-3.5 w-3.5" />}
                onClick={handleSettings}
                aria-label="Configure Text-to-Speech"
              >
                Configure Text-to-Speech
              </Button>
            </div>
          ) : null}

          {scopedStatus === "error" && scopedErrorMessage ? (
            <p className="text-xs text-[var(--content-secondary)]">
              {scopedErrorMessage}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="compact"
                iconOnly={
                  canPause ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )
                }
                aria-label={canPause ? "Pause radio" : "Play radio"}
                onClick={handlePrimaryPlayback}
              />
              <Button
                variant="ghost"
                size="compact"
                iconOnly={<SkipForward className="h-3.5 w-3.5" />}
                aria-label="Skip radio segment"
                onClick={handleSkip}
                disabled={!scopedCurrentTrack && scopedStatus !== "playing"}
              />
            </div>
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<X className="h-3.5 w-3.5" />}
              aria-label="Hide radio"
              onClick={hide}
            />
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
