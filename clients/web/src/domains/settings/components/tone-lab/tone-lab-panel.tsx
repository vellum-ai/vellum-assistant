import {
  AudioWaveform,
  ClipboardCopy,
  ClipboardPaste,
  CornerDownRight,
  Mic,
  Play,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  addLayer,
  canAddLayer,
  duplicateLayer,
  fromLogSlider,
  LOG_SLIDER_STEPS,
  recipesEqual,
  removeLayer,
  toLogSlider,
  updateLayer,
} from "@/domains/settings/components/tone-lab/tone-lab.helpers";
import { ToneLayerEditor } from "@/domains/settings/components/tone-lab/tone-layer-editor";
import { ToneWaveform } from "@/domains/settings/components/tone-lab/tone-waveform";
import { useTranslation } from "@/i18n";
import {
  TONE_PRESET_IDS,
  TONE_PRESETS,
  type TonePresetId,
} from "@/lib/sounds/tone-presets";
import {
  invertTone,
  playTone,
  sanitizeToneRecipe,
  TONE_LIMITS,
  type ToneRecipe,
} from "@/lib/sounds/tone-synth";
import {
  DEFAULT_VOICE_START_TONE,
  readVoiceStartToneOverride,
  writeVoiceStartToneOverride,
} from "@/lib/sounds/voice-start-tone";
import { Button } from "@vellumai/design-library/components/button";
import { FilterChip } from "@vellumai/design-library/components/filter-chip";
import { Slider } from "@vellumai/design-library/components/slider";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

const PRESET_LABEL_KEYS = {
  rise: "toneLab.presetNames.rise",
  glass: "toneLab.presetNames.glass",
  bloom: "toneLab.presetNames.bloom",
  wood: "toneLab.presetNames.wood",
  tuneIn: "toneLab.presetNames.tuneIn",
  doubleBlip: "toneLab.presetNames.doubleBlip",
  warm: "toneLab.presetNames.warm",
} as const satisfies Record<TonePresetId, string>;

/** Quiet period after the last edit before the tone auditions itself. */
const AUDITION_DEBOUNCE_MS = 250;

function first(value: number | [number, number]): number {
  return Array.isArray(value) ? value[0] : value;
}

function presetMatching(recipe: ToneRecipe): TonePresetId | null {
  return (
    TONE_PRESET_IDS.find((id) => recipesEqual(TONE_PRESETS[id], recipe)) ?? null
  );
}

/**
 * Debug tone lab: mix the tone a voice conversation plays when it connects
 * (its inverse plays when it ends), starting from a prebuilt, and audition it in a real call via a device-local
 * override.
 */
export function ToneLabPanel() {
  const { t } = useTranslation("settings");
  const [override, setOverride] = useState<ToneRecipe | null>(() =>
    readVoiceStartToneOverride(),
  );
  const [recipe, setRecipe] = useState<ToneRecipe>(
    () => override ?? DEFAULT_VOICE_START_TONE,
  );
  const [autoPlay, setAutoPlay] = useState(true);

  // Audition after edits settle, so a slider drag plays once rather than on
  // every tick. Skips the first render: opening the tab should not make noise.
  const lastAuditioned = useRef(recipe);
  useEffect(() => {
    if (!autoPlay || lastAuditioned.current === recipe) {
      return;
    }
    const timer = window.setTimeout(() => {
      lastAuditioned.current = recipe;
      void playTone(recipe);
    }, AUDITION_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [autoPlay, recipe]);

  const activePreset = presetMatching(recipe);
  const activeVoiceTone = override ?? DEFAULT_VOICE_START_TONE;
  const isVoiceTone = recipesEqual(recipe, activeVoiceTone);

  const loadPreset = (id: TonePresetId) => {
    const next = TONE_PRESETS[id];
    lastAuditioned.current = next;
    setRecipe(next);
    void playTone(next);
  };

  const handleUseForVoice = () => {
    if (recipesEqual(recipe, DEFAULT_VOICE_START_TONE)) {
      writeVoiceStartToneOverride(null);
      setOverride(null);
    } else {
      writeVoiceStartToneOverride(recipe);
      setOverride(recipe);
    }
    toast.success(t("toneLab.usedForVoiceToast"));
  };

  const handleResetVoice = () => {
    writeVoiceStartToneOverride(null);
    setOverride(null);
    toast.success(t("toneLab.resetVoiceToast"));
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(recipe, null, 2));
      toast.success(t("toneLab.copiedToast"));
    } catch {
      toast.error(t("toneLab.clipboardFailedToast"));
    }
  };

  const handlePaste = async () => {
    let parsed: ToneRecipe | null = null;
    try {
      parsed = sanitizeToneRecipe(
        JSON.parse(await navigator.clipboard.readText()),
      );
    } catch {
      parsed = null;
    }
    if (!parsed) {
      toast.error(t("toneLab.pasteInvalidToast"));
      return;
    }
    setRecipe(parsed);
  };

  const formatMs = (ms: number) => t("toneLab.msValue", { ms: Math.round(ms) });
  const formatPercent = (ratio: number) =>
    t("toneLab.percentValue", { percent: Math.round(ratio * 100) });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-base)]">
          <AudioWaveform className="h-5 w-5 text-[var(--content-secondary)]" />
        </div>
        <div>
          <h2 className="text-title-small text-[var(--content-default)]">
            {t("toneLab.title")}
          </h2>
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("toneLab.subtitle")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-base)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Mic className="h-4 w-4 shrink-0 text-[var(--content-secondary)]" />
          <p className="text-body-medium-default text-[var(--content-default)]">
            {override
              ? t("toneLab.voiceToneOverride")
              : t("toneLab.voiceToneDefault")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            leftIcon={<Play />}
            onClick={() => void playTone(activeVoiceTone)}
          >
            {t("toneLab.playVoiceTone")}
          </Button>
          {override && (
            <Button
              variant="outlined"
              leftIcon={<RotateCcw />}
              onClick={handleResetVoice}
            >
              {t("toneLab.resetVoiceTone")}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-body-medium-default text-[var(--content-default)]">
          {t("toneLab.presets")}
        </p>
        <div className="flex flex-wrap gap-2">
          {TONE_PRESET_IDS.map((id) => (
            <FilterChip
              key={id}
              selected={activePreset === id}
              onClick={() => loadPreset(id)}
            >
              {t(PRESET_LABEL_KEYS[id])}
            </FilterChip>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <ToneWaveform recipe={recipe} label={t("toneLab.waveformLabel")} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outlined"
              leftIcon={<Play />}
              onClick={() => void playTone(recipe)}
            >
              {t("toneLab.play")}
            </Button>
            <Button
              variant="ghost"
              leftIcon={<CornerDownRight />}
              onClick={() => void playTone(invertTone(recipe))}
            >
              {t("toneLab.playEnd")}
            </Button>
            <Button
              variant="ghost"
              leftIcon={<ClipboardCopy />}
              onClick={() => void handleCopy()}
            >
              {t("toneLab.copy")}
            </Button>
            <Button
              variant="ghost"
              leftIcon={<ClipboardPaste />}
              onClick={() => void handlePaste()}
            >
              {t("toneLab.paste")}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Toggle
              size="sm"
              checked={autoPlay}
              onChange={setAutoPlay}
              label={t("toneLab.autoPlay")}
            />
            <Button
              variant="primary"
              disabled={isVoiceTone}
              onClick={handleUseForVoice}
            >
              {t("toneLab.useForVoice")}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-[var(--border-base)] px-4 py-3">
        <p className="text-body-medium-default text-[var(--content-default)]">
          {t("toneLab.mix")}
        </p>
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Slider
            label={t("toneLab.volume")}
            showValue
            formatValue={() => formatPercent(recipe.gain)}
            value={recipe.gain}
            min={TONE_LIMITS.gain.min}
            max={TONE_LIMITS.gain.max}
            step={0.01}
            onValueChange={(v) => setRecipe((r) => ({ ...r, gain: first(v) }))}
          />
          <Slider
            label={t("toneLab.brightness")}
            showValue
            formatValue={() =>
              t("toneLab.hzPlainValue", { hz: Math.round(recipe.filterHz) })
            }
            value={toLogSlider(recipe.filterHz, TONE_LIMITS.filterHz)}
            min={0}
            max={LOG_SLIDER_STEPS}
            onValueChange={(v) =>
              setRecipe((r) => ({
                ...r,
                filterHz: fromLogSlider(first(v), TONE_LIMITS.filterHz),
              }))
            }
          />
          <Slider
            label={t("toneLab.echoTime")}
            showValue
            formatValue={() => formatMs(recipe.echoMs)}
            value={recipe.echoMs}
            min={TONE_LIMITS.echoMs.min}
            max={TONE_LIMITS.echoMs.max}
            step={5}
            onValueChange={(v) =>
              setRecipe((r) => ({ ...r, echoMs: first(v) }))
            }
          />
          <Slider
            label={t("toneLab.echoFeedback")}
            showValue
            formatValue={() => formatPercent(recipe.echoFeedback)}
            value={recipe.echoFeedback}
            min={TONE_LIMITS.echoFeedback.min}
            max={TONE_LIMITS.echoFeedback.max}
            step={0.01}
            onValueChange={(v) =>
              setRecipe((r) => ({ ...r, echoFeedback: first(v) }))
            }
          />
          <Slider
            label={t("toneLab.echoMix")}
            showValue
            formatValue={() => formatPercent(recipe.echoMix)}
            value={recipe.echoMix}
            min={TONE_LIMITS.echoMix.min}
            max={TONE_LIMITS.echoMix.max}
            step={0.01}
            onValueChange={(v) =>
              setRecipe((r) => ({ ...r, echoMix: first(v) }))
            }
          />
        </div>
      </div>

      {recipe.layers.map((layer, index) => (
        <ToneLayerEditor
          // Layers have no identity beyond their position in the recipe.
          key={index}
          index={index}
          layer={layer}
          canDuplicate={canAddLayer(recipe)}
          canRemove={recipe.layers.length > 1}
          onChange={(patch) => setRecipe((r) => updateLayer(r, index, patch))}
          onDuplicate={() => setRecipe((r) => duplicateLayer(r, index))}
          onRemove={() => setRecipe((r) => removeLayer(r, index))}
        />
      ))}

      <Button
        variant="outlined"
        leftIcon={<Plus />}
        disabled={!canAddLayer(recipe)}
        onClick={() => setRecipe((r) => addLayer(r))}
      >
        {t("toneLab.addLayer")}
      </Button>
    </div>
  );
}
