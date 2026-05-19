import type { JSX } from "react";

interface WakeMeterProps {
  readonly amplitude: number;
  readonly wakeWordActive: boolean;
  readonly listening: boolean;
  /**
   * Raw RMS value at which the voice-activity wake fires. The meter
   * draws its threshold marker at the corresponding position so the
   * visible gate matches the code gate (previously the marker was a
   * hard-coded 34% — far higher than the actual trigger — which made
   * the wake feel un-reachable without yelling).
   */
  readonly thresholdRms: number;
}

// Mirrors the amplitude scaling MicStream applies before handing the
// value to the React layer: `amplitude = min(1, rms * 4)`. The meter
// then renders width = `amplitude * 130%` (clamped). Keeping the same
// math here lets the threshold marker stay in lockstep with the bar.
const AMPLITUDE_GAIN = 4;
const BAR_GAIN = 130;
const MIN_BAR_PCT = 2;

function rmsToBarPct(rms: number): number {
  const amp = Math.min(1, Math.max(0, rms * AMPLITUDE_GAIN));
  return Math.min(100, Math.max(MIN_BAR_PCT, amp * BAR_GAIN));
}

/**
 * Compact horizontal threshold meter for wake-word/PTT readiness. The
 * green band marks the speech-detected zone; the marker shows current
 * RMS energy. When the wake word isn't active, the meter renders dimmed
 * so it's obvious the gate is bypassed.
 */
export function WakeMeter({
  amplitude,
  wakeWordActive,
  listening,
  thresholdRms,
}: WakeMeterProps): JSX.Element {
  const pct = Math.min(100, Math.max(MIN_BAR_PCT, amplitude * BAR_GAIN));
  const thresholdPct = rmsToBarPct(thresholdRms);
  const dim = !wakeWordActive && !listening;
  return (
    <div
      className={`relative h-2 w-full overflow-hidden rounded-sm border border-hud-panelBorder/60 bg-black/60 ${
        dim ? "opacity-50" : ""
      }`}
    >
      <div
        className="absolute inset-y-0 right-0 bg-hud-ok/15"
        style={{ left: `${thresholdPct}%` }}
        aria-hidden
      />
      <div
        className="absolute inset-y-0 w-[1px] bg-hud-ok/70"
        style={{ left: `${thresholdPct}%` }}
        aria-hidden
      />
      <div
        className="absolute inset-y-0 left-0 telemetry-bar"
        style={{ width: `${pct}%`, height: "100%", borderRadius: 0 }}
      />
      {listening ? (
        <div
          className="absolute top-0 h-full w-[2px] bg-white/80 shadow-[0_0_10px_white]"
          style={{ left: `${pct}%` }}
        />
      ) : null}
    </div>
  );
}
