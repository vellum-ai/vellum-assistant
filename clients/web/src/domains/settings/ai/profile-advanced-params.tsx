import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
import { Slider } from "@vellumai/design-library/components/slider";
import { Toggle } from "@vellumai/design-library/components/toggle";

import {
  DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS,
  TOKEN_SLIDER_MIN_TOKENS,
  TOKEN_SLIDER_STEP_TOKENS,
} from "@/domains/settings/ai/constants";
import {
  clampTokenBudget,
  formatCompactTokens,
} from "@/domains/settings/ai/utils";
import {
  type GeminiThinkingLevel,
  geminiThinkingLevels,
  type ProfileParamVisibility,
} from "@/domains/settings/ai/profile-param-visibility";
import { useSupportsCompleteProfileSnapshots } from "@/lib/backwards-compat/complete-profile-snapshots";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EFFORT_OPTIONS = [
  "inherit",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const SPEED_OPTIONS = ["standard", "fast"] as const;
const VERBOSITY_OPTIONS = ["low", "medium", "high"] as const;

/**
 * Sentinel for the Gemini thinking-level selector: "inherit" → omit
 * thinking.level so the daemon applies the model default. Concrete levels come
 * from `geminiThinkingLevels(model)`.
 */
export const THINKING_LEVEL_INHERIT = "default";

const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ProfileAdvancedParamsProps {
  visibility: ProfileParamVisibility;
  isReadOnly: boolean;
  model: string;
  /** Resolved catalog entry for the selected model (null if not in catalog). */
  selectedModel: {
    maxOutputTokens?: number;
    contextWindowTokens?: number;
  } | null;
  /**
   * Resolved `llm.default.maxTokens` from the loaded config — the output
   * budget a profile inherits when it leaves `maxTokens` unset. Undefined when
   * the config omits it, in which case the daemon applies its schema default.
   */
  defaultMaxOutputTokens?: number;
  /**
   * Resolved `llm.default.contextWindow.maxInputTokens` from the loaded config
   * — the input budget a profile inherits when it leaves the context window
   * unset. Undefined when the config omits it.
   */
  defaultContextWindowMaxInputTokens?: number;

  // Value + setter pairs for each advanced param
  maxTokens: number | null;
  onMaxTokensChange: (v: number | null) => void;
  contextWindowMaxInputTokens: number | null;
  onContextWindowChange: (v: number | null) => void;
  effort: (typeof EFFORT_OPTIONS)[number];
  onEffortChange: (v: (typeof EFFORT_OPTIONS)[number]) => void;
  speed: (typeof SPEED_OPTIONS)[number];
  onSpeedChange: (v: (typeof SPEED_OPTIONS)[number]) => void;
  verbosity: (typeof VERBOSITY_OPTIONS)[number];
  onVerbosityChange: (v: (typeof VERBOSITY_OPTIONS)[number]) => void;
  temperatureEnabled: boolean;
  onTemperatureEnabledChange: (v: boolean) => void;
  temperature: number;
  onTemperatureChange: (v: number) => void;
  topPEnabled: boolean;
  onTopPEnabledChange: (v: boolean) => void;
  topP: number;
  onTopPChange: (v: number) => void;
  thinkingEnabled: boolean;
  onThinkingEnabledChange: (v: boolean) => void;
  thinkingStreamThinking: boolean;
  onThinkingStreamThinkingChange: (v: boolean) => void;
  thinkingLevel: GeminiThinkingLevel | typeof THINKING_LEVEL_INHERIT;
  onThinkingLevelChange: (
    v: GeminiThinkingLevel | typeof THINKING_LEVEL_INHERIT,
  ) => void;
}

interface TokenBudgetFieldProps {
  label: string;
  /** Explicit override in tokens, or null to inherit the model default. */
  value: number | null;
  onChange: (next: number | null) => void;
  /** Value the daemon applies when no override is set. */
  defaultValue: number;
  /** Upper bound the model supports — the slider max and clamp ceiling. */
  max: number;
  disabled: boolean;
}

/**
 * A token-budget control: a fine-grained slider paired with a numeric input for
 * typing an exact limit, plus a Reset that clears the override. When no override
 * is set the field reads as the resolved default — shown both as a compact label
 * and as the input's placeholder — so the effective value is never hidden behind
 * the bare word "Default".
 */
function TokenBudgetField({
  label,
  value,
  onChange,
  defaultValue,
  max,
  disabled,
}: TokenBudgetFieldProps) {
  const isDefault = value === null;
  const effectiveValue = value ?? defaultValue;

  // The number field keeps its in-progress edit as free text so partial entries
  // (e.g. "12" on the way to "128000") aren't clamped mid-keystroke. An empty
  // string means "inherit the model default".
  const [draft, setDraft] = useState(isDefault ? "" : String(value));
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    // The slider, Reset, or a model switch changed the value out from under the
    // field — adopt it as the new baseline.
    // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
    setSyncedValue(value);
    setDraft(value === null ? "" : String(value));
  }

  function handleText(raw: string) {
    setDraft(raw);
    const trimmed = raw.trim();
    if (trimmed === "") {
      onChange(null);
      return;
    }
    const parsed = Number(trimmed);
    // Commit live only while in range so the slider tracks typing without
    // snapping partial or out-of-range entries; the blur handler clamps the
    // rest.
    if (
      Number.isFinite(parsed) &&
      parsed >= TOKEN_SLIDER_MIN_TOKENS &&
      parsed <= max
    ) {
      onChange(parsed);
    }
  }

  function commitText(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onChange(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(value === null ? "" : String(value));
      return;
    }
    const clamped = clampTokenBudget(parsed, max);
    setDraft(String(clamped));
    onChange(clamped);
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          {label}
        </label>
        {isDefault ? (
          <span className="text-body-small-default text-[var(--content-tertiary)]">
            Default · {formatCompactTokens(defaultValue)}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Slider
            value={effectiveValue}
            onValueChange={(v) => onChange(typeof v === "number" ? v : v[0])}
            min={TOKEN_SLIDER_MIN_TOKENS}
            max={max}
            step={TOKEN_SLIDER_STEP_TOKENS}
            disabled={disabled}
            aria-label={label}
          />
        </div>
        <Input
          type="number"
          inputMode="numeric"
          value={draft}
          placeholder={String(defaultValue)}
          onChange={(e) => handleText(e.target.value)}
          onBlur={(e) => commitText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitText(e.currentTarget.value);
            }
          }}
          min={TOKEN_SLIDER_MIN_TOKENS}
          max={max}
          step={TOKEN_SLIDER_STEP_TOKENS}
          disabled={disabled}
          aria-label={`${label} (tokens)`}
          wrapperClassName="w-32 shrink-0"
          className="text-right tabular-nums"
        />
        <Button
          variant="ghost"
          size="compact"
          onClick={() => onChange(null)}
          disabled={disabled || isDefault}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

/**
 * Renders the advanced parameter controls for the profile editor modal.
 * Each control is gated by a `visibility` flag derived from the selected
 * provider/model combination. Hidden entirely when no provider/model is
 * selected (all flags false).
 */
export function ProfileAdvancedParams({
  visibility,
  isReadOnly,
  model,
  selectedModel,
  defaultMaxOutputTokens,
  defaultContextWindowMaxInputTokens,
  maxTokens,
  onMaxTokensChange,
  contextWindowMaxInputTokens,
  onContextWindowChange,
  effort,
  onEffortChange,
  speed,
  onSpeedChange,
  verbosity,
  onVerbosityChange,
  temperatureEnabled,
  onTemperatureEnabledChange,
  temperature,
  onTemperatureChange,
  topPEnabled,
  onTopPEnabledChange,
  topP,
  onTopPChange,
  thinkingEnabled,
  onThinkingEnabledChange,
  thinkingStreamThinking,
  onThinkingStreamThinkingChange,
  thinkingLevel,
  onThinkingLevelChange,
}: ProfileAdvancedParamsProps) {
  const supportsSnapshots = useSupportsCompleteProfileSnapshots();

  // Each model's hard ceiling doubles as that field's slider/input max. The
  // resolved runtime defaults, however, are what a profile inherits when it
  // omits the override: `llm.default.maxTokens` and
  // `llm.default.contextWindow.maxInputTokens` from the loaded config (or their
  // schema defaults — 64000 / 200000 — when the config omits them). Each is
  // clamped to its model ceiling so the displayed default never advertises a
  // budget the model can't honor.
  const maxOutputCeiling =
    selectedModel?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const contextWindowCeiling =
    selectedModel?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS;
  const resolvedMaxOutputDefault = Math.min(
    defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    maxOutputCeiling,
  );
  const resolvedContextWindowDefault = Math.min(
    defaultContextWindowMaxInputTokens ?? DEFAULT_CONTEXT_WINDOW_BUDGET_TOKENS,
    contextWindowCeiling,
  );

  return (
    // space-y-4 matches the modal body's rhythm so each advanced param gets
    // the same vertical breathing room as the "normal" fields above. Without
    // a spacing wrapper the fragment stacked these blocks flush against each
    // other (and against the disclosure edges).
    <div className="space-y-4">
      {!isReadOnly && supportsSnapshots && (
        // Profiles are complete overrides: fields left at their default are
        // baked into the profile at save time and do not track later changes
        // to the assistant defaults. Pre-0.10.8 assistants still live-inherit
        // (deep merge), so the line is hidden against them.
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          Fields left at their default are saved with the values shown and won’t
          change if the assistant defaults change later.
        </p>
      )}
      {visibility.maxTokens && (
        <TokenBudgetField
          label="Max Output Tokens"
          value={maxTokens}
          onChange={onMaxTokensChange}
          defaultValue={resolvedMaxOutputDefault}
          max={maxOutputCeiling}
          disabled={isReadOnly}
        />
      )}

      {visibility.contextWindow && (
        <TokenBudgetField
          label="Context Window"
          value={contextWindowMaxInputTokens}
          onChange={onContextWindowChange}
          defaultValue={resolvedContextWindowDefault}
          max={contextWindowCeiling}
          disabled={isReadOnly || !selectedModel}
        />
      )}

      {/* Effort */}
      {visibility.effort && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Effort
          </label>
          <SegmentControl
            items={EFFORT_OPTIONS.map((v) => ({
              value: v,
              // "inherit" is a wire sentinel; post-M6 the saved profile bakes
              // the current default, so the UI says "default", not "inherit".
              label: v === "inherit" ? "default" : v,
              disabled: isReadOnly,
            }))}
            value={effort}
            onChange={(v) => onEffortChange(v)}
            ariaLabel="Effort"
          />
        </div>
      )}

      {/* Speed */}
      {visibility.speed && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Speed
          </label>
          <SegmentControl
            items={SPEED_OPTIONS.map((v) => ({
              value: v,
              label: v,
              disabled: isReadOnly,
            }))}
            value={speed}
            onChange={(v) => onSpeedChange(v)}
            ariaLabel="Speed"
          />
        </div>
      )}

      {/* Verbosity */}
      {visibility.verbosity && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Verbosity
          </label>
          <SegmentControl
            items={VERBOSITY_OPTIONS.map((v) => ({
              value: v,
              label: v,
              disabled: isReadOnly,
            }))}
            value={verbosity}
            onChange={(v) => onVerbosityChange(v)}
            ariaLabel="Verbosity"
          />
        </div>
      )}

      {/* Temperature */}
      {visibility.temperature && (
        <div className="space-y-2">
          <Toggle
            checked={temperatureEnabled}
            onChange={(v) => onTemperatureEnabledChange(v)}
            label="Temperature"
            disabled={isReadOnly}
          />
          {temperatureEnabled && (
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <Slider
                  value={temperature}
                  onValueChange={(v) =>
                    onTemperatureChange(typeof v === "number" ? v : v[0])
                  }
                  min={0}
                  max={2}
                  step={0.01}
                  disabled={isReadOnly}
                  showValue
                  formatValue={(v) =>
                    typeof v === "number" ? v.toFixed(2) : String(v)
                  }
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Top P */}
      {visibility.topP && (
        <div className="space-y-2">
          <Toggle
            checked={topPEnabled}
            onChange={(v) => onTopPEnabledChange(v)}
            label="Top P"
            disabled={isReadOnly}
          />
          {topPEnabled && (
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <Slider
                  value={topP}
                  onValueChange={(v) =>
                    onTopPChange(typeof v === "number" ? v : v[0])
                  }
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={isReadOnly}
                  showValue
                  formatValue={(v) =>
                    typeof v === "number" ? v.toFixed(2) : String(v)
                  }
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Thinking */}
      {visibility.thinking && (
        <div className="space-y-3">
          <Toggle
            checked={thinkingEnabled}
            onChange={(v) => {
              onThinkingEnabledChange(v);
              if (!v) {
                onThinkingStreamThinkingChange(false);
              }
            }}
            label="Enable extended thinking"
            disabled={isReadOnly}
          />
          {thinkingEnabled && (
            <div className="pl-4">
              <Toggle
                checked={thinkingStreamThinking}
                onChange={(v) => onThinkingStreamThinkingChange(v)}
                label="Stream thinking tokens"
                disabled={isReadOnly}
              />
            </div>
          )}
        </div>
      )}

      {/* Thinking level (Gemini) */}
      {visibility.thinkingLevel && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Thinking level{" "}
            <span className="text-[var(--content-disabled)]">
              (default = inherit)
            </span>
          </label>
          <SegmentControl
            items={(
              [THINKING_LEVEL_INHERIT, ...geminiThinkingLevels(model)] as const
            ).map((v) => ({
              value: v,
              label: `${v}`,
              disabled: isReadOnly,
            }))}
            value={thinkingLevel}
            onChange={onThinkingLevelChange}
            ariaLabel="Thinking level"
          />
        </div>
      )}
    </div>
  );
}
