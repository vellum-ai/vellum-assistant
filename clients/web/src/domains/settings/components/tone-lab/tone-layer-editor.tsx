import { Copy, Trash2 } from "lucide-react";

import {
  fromLogSlider,
  LOG_SLIDER_STEPS,
  toLogSlider,
} from "@/domains/settings/components/tone-lab/tone-lab.helpers";
import { useTranslation } from "@/i18n";
import {
  noteNameForFrequency,
  TONE_LIMITS,
  TONE_WAVEFORMS,
  type ToneLayer,
  type ToneWaveform,
} from "@/lib/sounds/tone-synth";
import { Button } from "@vellumai/design-library/components/button";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
import { Slider } from "@vellumai/design-library/components/slider";

const WAVEFORM_LABEL_KEYS = {
  sine: "toneLab.waveforms.sine",
  triangle: "toneLab.waveforms.triangle",
  square: "toneLab.waveforms.square",
  sawtooth: "toneLab.waveforms.sawtooth",
} as const satisfies Record<ToneWaveform, string>;

function first(value: number | [number, number]): number {
  return Array.isArray(value) ? value[0] : value;
}

export function ToneLayerEditor({
  index,
  layer,
  canDuplicate,
  canRemove,
  onChange,
  onDuplicate,
  onRemove,
}: {
  index: number;
  layer: ToneLayer;
  canDuplicate: boolean;
  canRemove: boolean;
  onChange: (patch: Partial<ToneLayer>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("settings");

  const formatHz = (hz: number) =>
    t("toneLab.hzValue", {
      hz: Math.round(hz),
      note: noteNameForFrequency(hz),
    });
  const formatMs = (ms: number) => t("toneLab.msValue", { ms: Math.round(ms) });
  const formatPercent = (ratio: number) =>
    t("toneLab.percentValue", { percent: Math.round(ratio * 100) });

  const waveformItems = TONE_WAVEFORMS.map((waveform) => ({
    value: waveform,
    label: t(WAVEFORM_LABEL_KEYS[waveform]),
  }));

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-base)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-body-medium-default text-[var(--content-default)]">
          {t("toneLab.layerTitle", { number: index + 1 })}
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<Copy />}
            aria-label={t("toneLab.duplicateLayer")}
            disabled={!canDuplicate}
            onClick={onDuplicate}
          />
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<Trash2 />}
            aria-label={t("toneLab.removeLayer")}
            disabled={!canRemove}
            onClick={onRemove}
          />
        </div>
      </div>

      <SegmentControl<ToneWaveform>
        items={waveformItems}
        value={layer.waveform}
        onChange={(waveform) => onChange({ waveform })}
        ariaLabel={t("toneLab.waveform")}
      />

      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Slider
          label={t("toneLab.pitch")}
          showValue
          formatValue={() => formatHz(layer.frequency)}
          value={toLogSlider(layer.frequency, TONE_LIMITS.frequency)}
          min={0}
          max={LOG_SLIDER_STEPS}
          onValueChange={(v) =>
            onChange({
              frequency: fromLogSlider(first(v), TONE_LIMITS.frequency),
            })
          }
        />
        <Slider
          label={t("toneLab.glideTo")}
          showValue
          formatValue={() => formatHz(layer.glideTo)}
          value={toLogSlider(layer.glideTo, TONE_LIMITS.frequency)}
          min={0}
          max={LOG_SLIDER_STEPS}
          onValueChange={(v) =>
            onChange({
              glideTo: fromLogSlider(first(v), TONE_LIMITS.frequency),
            })
          }
        />
        <Slider
          label={t("toneLab.start")}
          showValue
          formatValue={() => formatMs(layer.startMs)}
          value={layer.startMs}
          min={TONE_LIMITS.startMs.min}
          max={1000}
          step={5}
          onValueChange={(v) => onChange({ startMs: first(v) })}
        />
        <Slider
          label={t("toneLab.level")}
          showValue
          formatValue={() => formatPercent(layer.gain)}
          value={layer.gain}
          min={TONE_LIMITS.gain.min}
          max={TONE_LIMITS.gain.max}
          step={0.01}
          onValueChange={(v) => onChange({ gain: first(v) })}
        />
        <Slider
          label={t("toneLab.attack")}
          showValue
          formatValue={() => formatMs(layer.attackMs)}
          value={layer.attackMs}
          min={TONE_LIMITS.attackMs.min}
          max={300}
          onValueChange={(v) => onChange({ attackMs: first(v) })}
        />
        <Slider
          label={t("toneLab.decay")}
          showValue
          formatValue={() => formatMs(layer.decayMs)}
          value={layer.decayMs}
          min={TONE_LIMITS.decayMs.min}
          max={1500}
          step={5}
          onValueChange={(v) => onChange({ decayMs: first(v) })}
        />
        <Slider
          label={t("toneLab.detune")}
          showValue
          formatValue={() =>
            t("toneLab.centsValue", { cents: Math.round(layer.detuneCents) })
          }
          value={layer.detuneCents}
          min={TONE_LIMITS.detuneCents.min}
          max={TONE_LIMITS.detuneCents.max}
          onValueChange={(v) => onChange({ detuneCents: first(v) })}
        />
      </div>
    </div>
  );
}
