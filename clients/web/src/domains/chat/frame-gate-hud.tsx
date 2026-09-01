/**
 * The frame gate's tuning panel: what the last frame scored, which of the
 * gate's checks decided it, and sliders for the thresholds those checks read.
 *
 * One component serves both camera surfaces. Each mount names the surface it
 * belongs to and renders nothing unless that surface is the one currently
 * feeding the gate, so the composer's tile and the voice room's viewfinder can
 * both mount a panel without ever putting two on screen.
 *
 * ## Why the meters are drawn against the slider ranges
 *
 * A bar needs a scale, and a scale that grew with the value would move the
 * tick mark under the reader every frame. Each meter is drawn against its
 * threshold's slider range instead, so the tick sits at the same fraction of
 * the bar as the slider's thumb and the two read as one control.
 *
 * ## What a render costs
 *
 * The panel re-renders once per animation frame while a camera is open, which
 * is what a live readout is. It is a leaf with nothing under it, mounted only
 * for a session that has turned the readout on, and it renders null the rest
 * of the time, so the cost is confined to this subtree and to the sessions
 * asking for it.
 */

import { useSyncExternalStore, type CSSProperties } from "react";
import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Slider } from "@vellumai/design-library/components/slider";

import { CAMERA_MEDIA_GLASS_CLASS } from "@/domains/chat/voice/voice-room/camera-mode-paint";
import { useCameraGateHudEnabled } from "@/hooks/use-camera-gate-hud";
import { useTranslation } from "@/i18n";
import {
  DEFAULT_FRAME_GATE_OPTIONS,
  frameGateDecisionPath,
  type FrameGateReason,
} from "@/lib/camera/frame-gate";
import {
  FRAME_GATE_OVERRIDE_KEYS,
  FRAME_GATE_SLIDER_BOUNDS,
  getFrameGateDebugSnapshot,
  subscribeFrameGateDebug,
  type FrameGateDebugDecision,
  type FrameGateDebugSurface,
  type FrameGateOverrideKey,
} from "@/lib/camera/frame-gate-debug";
import { useCameraGateDebugStore } from "@/stores/camera-gate-debug-store";

/**
 * Catalog keys as literal maps rather than assembled paths: the catalog test
 * looks for each key as a literal in the source, and a built path would leave
 * every message reading as unreferenced copy.
 */
const REASON_TEXT_KEYS = {
  warmup: "frameGateHud.reasonWarmup",
  featureless: "frameGateHud.reasonFeatureless",
  first: "frameGateHud.reasonFirst",
  "rate-floor": "frameGateHud.reasonRateFloor",
  moving: "frameGateHud.reasonMoving",
  heartbeat: "frameGateHud.reasonHeartbeat",
  novel: "frameGateHud.reasonNovel",
  unchanged: "frameGateHud.reasonUnchanged",
} as const satisfies Record<FrameGateReason, string>;

const STEP_LABEL_KEYS = {
  warmup: "frameGateHud.stepWarmup",
  featureless: "frameGateHud.stepFeatureless",
  first: "frameGateHud.stepFirst",
  "rate-floor": "frameGateHud.stepRateFloor",
  moving: "frameGateHud.stepMoving",
  heartbeat: "frameGateHud.stepHeartbeat",
  novel: "frameGateHud.stepNovel",
  unchanged: "frameGateHud.stepUnchanged",
} as const satisfies Record<FrameGateReason, string>;

const SLIDER_LABEL_KEYS = {
  noveltyThreshold: "frameGateHud.noveltyThresholdLabel",
  settleThreshold: "frameGateHud.settleThresholdLabel",
  minDetail: "frameGateHud.minDetailLabel",
  minIntervalMs: "frameGateHud.minIntervalLabel",
  maxIntervalMs: "frameGateHud.maxIntervalLabel",
} as const satisfies Record<FrameGateOverrideKey, string>;

const SURFACE_LABEL_KEYS = {
  composer: "frameGateHud.surfaceComposer",
  voice: "frameGateHud.surfaceVoice",
} as const satisfies Record<FrameGateDebugSurface, string>;

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const COUNT_FORMAT = new Intl.NumberFormat();
const SECONDS_FORMAT = new Intl.NumberFormat(undefined, {
  style: "unit",
  unit: "second",
  maximumFractionDigits: 1,
});

function formatThreshold(key: FrameGateOverrideKey, value: number): string {
  if (key === "minIntervalMs" || key === "maxIntervalMs") {
    return SECONDS_FORMAT.format(value / 1000);
  }
  return SCORE_FORMAT.format(value);
}

/** Where a value sits on its meter, as a percentage of the bar. */
function barPercent(value: number, scaleMax: number): number {
  if (scaleMax <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (value / scaleMax) * 100));
}

interface MeterProps {
  label: string;
  absentLabel: string;
  /** Null where the gate had nothing to compare against for this frame. */
  value: number | null;
  threshold: number;
  scaleMax: number;
  /** Whether the value is on the side of the threshold that allows a keep. */
  met: boolean;
}

function Meter({
  label,
  absentLabel,
  value,
  threshold,
  scaleMax,
  met,
}: MeterProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-white/60">
          {label}
        </span>
        <span className="font-mono text-[11px] tabular-nums">
          {value === null ? absentLabel : SCORE_FORMAT.format(value)}
        </span>
      </div>
      <div className="relative h-1.5 w-full rounded-full bg-white/20">
        {value !== null ? (
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              met ? "bg-[var(--system-positive-strong)]" : "bg-white/70",
            )}
            style={{ width: `${barPercent(value, scaleMax)}%` }}
          />
        ) : null}
        {/* The threshold, drawn on the bar rather than written beside it: the
            question a reader has is which side of it the value is on. */}
        <div
          aria-hidden
          className="absolute -top-0.5 h-2.5 w-0.5 rounded-full bg-white"
          style={{ left: `${barPercent(threshold, scaleMax)}%` }}
        />
      </div>
    </div>
  );
}

interface ThresholdSliderProps {
  label: string;
  overriddenLabel: string;
  overrideKey: FrameGateOverrideKey;
  value: number;
}

function ThresholdSlider({
  label,
  overriddenLabel,
  overrideKey,
  value,
}: ThresholdSliderProps) {
  const setOverride = useCameraGateDebugStore.use.setOverride();
  const bound = FRAME_GATE_SLIDER_BOUNDS[overrideKey];
  const overridden = value !== DEFAULT_FRAME_GATE_OPTIONS[overrideKey];

  return (
    <div
      data-testid={`frame-gate-hud-slider-${overrideKey}`}
      className="flex flex-col gap-1"
    >
      <div className="flex items-center gap-1.5">
        {/* A moved threshold has to be visible without remembering what the
            default was, since every number on the panel is read against it. */}
        {overridden ? (
          <span
            title={overriddenLabel}
            aria-label={overriddenLabel}
            className="size-1.5 shrink-0 rounded-full bg-[var(--system-positive-strong)]"
          />
        ) : null}
        <span className="text-[10px] uppercase tracking-wide text-white/60">
          {label}
        </span>
      </div>
      <Slider
        value={value}
        onValueChange={(next) => {
          if (typeof next === "number") {
            setOverride(overrideKey, next);
          }
        }}
        min={bound.min}
        max={bound.max}
        step={bound.step}
        showValue
        formatValue={(shown) =>
          formatThreshold(
            overrideKey,
            typeof shown === "number" ? shown : shown[0],
          )
        }
        aria-label={label}
      />
    </div>
  );
}

export interface FrameGateHudProps {
  /** Which camera this mount belongs to. */
  surface: FrameGateDebugSurface;
  /** Positioning for the mount, which owns where the panel sits. */
  className?: string;
  /** Positioning that has to be computed, such as a safe-area inset. */
  style?: CSSProperties;
}

export function FrameGateHud({ surface, className, style }: FrameGateHudProps) {
  const { t } = useTranslation("chat");
  const enabled = useCameraGateHudEnabled();
  const overrides = useCameraGateDebugStore.use.overrides();
  const resetOverrides = useCameraGateDebugStore.use.resetOverrides();
  const snapshot = useSyncExternalStore(
    subscribeFrameGateDebug,
    getFrameGateDebugSnapshot,
    getFrameGateDebugSnapshot,
  );

  const latest: FrameGateDebugDecision | null = snapshot.latest;
  if (!enabled || snapshot.surface !== surface || !latest) {
    return null;
  }

  const absentLabel = t("frameGateHud.valueAbsent");
  const decisionPath = frameGateDecisionPath(latest);

  return (
    <div
      data-slot="frame-gate-hud"
      data-testid="frame-gate-hud"
      style={style}
      className={cn(
        "w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg p-3",
        "flex flex-col gap-3 text-[11px] leading-tight shadow-lg",
        CAMERA_MEDIA_GLASS_CLASS,
        className,
      )}
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold uppercase tracking-wide">
            {latest.keep ? t("frameGateHud.keep") : t("frameGateHud.skip")}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-white/60">
            {t(SURFACE_LABEL_KEYS[snapshot.surface])}
          </span>
        </div>
        <p className="text-white/75">{t(REASON_TEXT_KEYS[latest.reason])}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Meter
          label={t("frameGateHud.motionLabel")}
          absentLabel={absentLabel}
          value={latest.motion}
          threshold={overrides.settleThreshold}
          scaleMax={FRAME_GATE_SLIDER_BOUNDS.settleThreshold.max}
          met={
            latest.motion !== null && latest.motion < overrides.settleThreshold
          }
        />
        <Meter
          label={t("frameGateHud.noveltyLabel")}
          absentLabel={absentLabel}
          value={latest.novelty}
          threshold={overrides.noveltyThreshold}
          scaleMax={FRAME_GATE_SLIDER_BOUNDS.noveltyThreshold.max}
          met={
            latest.novelty !== null &&
            latest.novelty >= overrides.noveltyThreshold
          }
        />
        <Meter
          label={t("frameGateHud.detailLabel")}
          absentLabel={absentLabel}
          value={latest.detail}
          threshold={overrides.minDetail}
          scaleMax={FRAME_GATE_SLIDER_BOUNDS.minDetail.max}
          met={latest.detail >= overrides.minDetail}
        />
      </div>

      {/* The checks this frame was actually put through, in the order the gate
          ran them, so the highlighted row says not only what decided the frame
          but everything it got past first. The branch the gate took decides
          which checks are listed: before its first keep it has no baseline to
          score against, so the novelty checks are not on the frame's path at
          all. The count beside each one is how often it has decided. */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-white/60">
          {t("frameGateHud.decisionOrder")}
        </span>
        <ol className="flex flex-col">
          {decisionPath.map((reason, index) => {
            const decided = reason === latest.reason;
            const unreached = index > decisionPath.indexOf(latest.reason);
            return (
              <li
                key={reason}
                data-testid={`frame-gate-hud-step-${reason}`}
                data-decided={decided ? "true" : undefined}
                className={cn(
                  "flex items-baseline justify-between gap-2 rounded px-1 py-0.5",
                  decided && "bg-white/15 font-semibold",
                  unreached && "text-white/35",
                )}
              >
                <span>{t(STEP_LABEL_KEYS[reason])}</span>
                <span className="font-mono tabular-nums text-white/60">
                  {COUNT_FORMAT.format(snapshot.reasonCounts[reason])}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* One mark per judged frame, newest first: the shape of a burst of
          skips is the thing the counters above cannot show. */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-white/60">
          {t("frameGateHud.recentFrames")}
        </span>
        <div aria-hidden className="flex flex-row-reverse gap-0.5">
          {snapshot.recent.map((decision) => (
            <span
              key={decision.atMs}
              className={cn(
                "h-3 w-1 rounded-sm",
                decision.keep
                  ? "bg-[var(--system-positive-strong)]"
                  : "bg-white/25",
              )}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-white/60">
          {t("frameGateHud.recentKeeps")}
        </span>
        {snapshot.keeps.length === 0 ? (
          <p className="text-white/50">{t("frameGateHud.noKeeps")}</p>
        ) : (
          <div className="flex gap-1">
            {snapshot.keeps.map((keep) => (
              <img
                key={keep.url}
                src={keep.url}
                alt={t("frameGateHud.keptFrameAlt")}
                className="h-9 w-12 rounded object-cover"
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-white/60">
            {t("frameGateHud.thresholds")}
          </span>
          <Button
            variant="ghost"
            size="compact"
            expandOnMobile={false}
            onClick={resetOverrides}
            className="[--vbtn-fg:var(--aux-white)]"
          >
            {t("frameGateHud.reset")}
          </Button>
        </div>
        {FRAME_GATE_OVERRIDE_KEYS.map((key) => (
          <ThresholdSlider
            key={key}
            label={t(SLIDER_LABEL_KEYS[key])}
            overriddenLabel={t("frameGateHud.overridden")}
            overrideKey={key}
            value={overrides[key]}
          />
        ))}
      </div>
    </div>
  );
}
