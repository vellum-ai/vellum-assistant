import { Button } from "@vellumai/design-library/components/button";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
import { Slider } from "@vellumai/design-library/components/slider";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { formatCompactTokens } from "@/domains/settings/ai/ai-utils";
import {
    geminiThinkingLevels,
    type ProfileParamVisibility,
} from "@/domains/settings/ai/profile-param-visibility";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EFFORT_OPTIONS = [
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
 * thinking.level so the daemon applies the model default (mirrors effort's
 * "none"). Concrete levels come from `geminiThinkingLevels(model)`.
 */
export const THINKING_LEVEL_INHERIT = "default";

const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const MIN_MAX_OUTPUT_TOKENS = 1_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const MIN_CONTEXT_WINDOW_TOKENS = 1_000;

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

  // Value + setter pairs for each advanced param
  maxTokens: number | null;
  onMaxTokensChange: (v: number | null) => void;
  contextWindowMaxInputTokens: number | null;
  onContextWindowChange: (v: number | null) => void;
  effort: string;
  onEffortChange: (v: string) => void;
  speed: string;
  onSpeedChange: (v: string) => void;
  verbosity: string;
  onVerbosityChange: (v: string) => void;
  temperatureEnabled: boolean;
  onTemperatureEnabledChange: (v: boolean) => void;
  temperature: number;
  onTemperatureChange: (v: number) => void;
  thinkingEnabled: boolean;
  onThinkingEnabledChange: (v: boolean) => void;
  thinkingStreamThinking: boolean;
  onThinkingStreamThinkingChange: (v: boolean) => void;
  thinkingLevel: string;
  onThinkingLevelChange: (v: string) => void;
}

/**
 * Renders the advanced parameter controls for the profile editor modal.
 * Each control is gated by a `visibility` flag derived from the selected
 * provider/model combination. Hidden entirely when no provider/model is
 * selected (all flags false) or when the profile is the "auto" meta-profile.
 */
export function ProfileAdvancedParams({
  visibility,
  isReadOnly,
  model,
  selectedModel,
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
  thinkingEnabled,
  onThinkingEnabledChange,
  thinkingStreamThinking,
  onThinkingStreamThinkingChange,
  thinkingLevel,
  onThinkingLevelChange,
}: ProfileAdvancedParamsProps) {
  return (
    // space-y-4 matches the modal body's rhythm so each advanced param gets
    // the same vertical breathing room as the "normal" fields above. Without
    // a spacing wrapper the fragment stacked these blocks flush against each
    // other (and against the disclosure edges).
    <div className="space-y-4">
      {/* Max Output Tokens */}
      {visibility.maxTokens && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Max Output Tokens
            </label>
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              {maxTokens !== null
                ? formatCompactTokens(maxTokens)
                : "Inherit"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Slider
                value={maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS}
                onValueChange={(v) =>
                  onMaxTokensChange(typeof v === "number" ? v : v[0])
                }
                min={MIN_MAX_OUTPUT_TOKENS}
                max={
                  selectedModel?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
                }
                step={1_000}
                disabled={isReadOnly}
              />
            </div>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => onMaxTokensChange(null)}
              disabled={isReadOnly || maxTokens === null}
            >
              Reset
            </Button>
          </div>
        </div>
      )}

      {/* Context Window */}
      {visibility.contextWindow && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Context Window
            </label>
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              {contextWindowMaxInputTokens !== null
                ? formatCompactTokens(contextWindowMaxInputTokens)
                : "Inherit"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Slider
                value={
                  contextWindowMaxInputTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
                }
                onValueChange={(v) =>
                  onContextWindowChange(typeof v === "number" ? v : v[0])
                }
                min={MIN_CONTEXT_WINDOW_TOKENS}
                max={
                  selectedModel?.contextWindowTokens ??
                  DEFAULT_CONTEXT_WINDOW_TOKENS
                }
                step={50_000}
                disabled={isReadOnly || !selectedModel}
              />
            </div>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => onContextWindowChange(null)}
              disabled={isReadOnly || contextWindowMaxInputTokens === null}
            >
              Reset
            </Button>
          </div>
        </div>
      )}

      {/* Effort */}
      {visibility.effort && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Effort{" "}
            <span className="text-[var(--content-disabled)]">
              (none = inherit)
            </span>
          </label>
          <SegmentControl
            items={EFFORT_OPTIONS.map((v) => ({ value: v, label: v }))}
            value={effort as (typeof EFFORT_OPTIONS)[number]}
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
            items={SPEED_OPTIONS.map((v) => ({ value: v, label: v }))}
            value={speed as (typeof SPEED_OPTIONS)[number]}
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
            items={VERBOSITY_OPTIONS.map((v) => ({ value: v, label: v }))}
            value={verbosity as (typeof VERBOSITY_OPTIONS)[number]}
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

      {/* Thinking */}
      {visibility.thinking && (
        <div className="space-y-3">
          <Toggle
            checked={thinkingEnabled}
            onChange={(v) => {
              onThinkingEnabledChange(v);
              if (!v) onThinkingStreamThinkingChange(false);
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
            items={[THINKING_LEVEL_INHERIT, ...geminiThinkingLevels(model)].map(
              (v) => ({
                value: v,
                label: v,
              }),
            )}
            value={thinkingLevel}
            onChange={(v) => onThinkingLevelChange(v)}
            ariaLabel="Thinking level"
          />
        </div>
      )}
    </div>
  );
}
