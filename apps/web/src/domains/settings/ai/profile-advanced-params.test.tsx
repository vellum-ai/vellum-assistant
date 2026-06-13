/**
 * Tests for the token-budget controls (Max Output Tokens / Context Window) in
 * `ProfileAdvancedParams`:
 *
 *   1. With no override set, the field surfaces the resolved default
 *      numerically — a "Default · NNN" label, the slider thumb parked at the
 *      resolved value, and the same value as the input's placeholder — instead
 *      of hiding it behind the bare word "Default". Context Window resolves to
 *      the model's default window, while Max Output resolves to the global
 *      `llm.default.maxTokens` schema default (bounded by the model's hard
 *      output ceiling), not the model's max output.
 *   2. The limit can be set explicitly by typing into the numeric input, not
 *      only by dragging the slider; clearing the input restores the default,
 *      and out-of-range entries clamp to the model's bounds on blur.
 *   3. The slider steps in fine 1,000-token increments rather than large
 *      quartile jumps.
 *
 * Each field is isolated by toggling a single `visibility` flag so only one
 * slider/input pair renders per case.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ProfileAdvancedParams } from "@/domains/settings/ai/profile-advanced-params";
import {
  type ProfileParamVisibility,
  VISIBILITY_NONE,
} from "@/domains/settings/ai/profile-param-visibility";

const MODEL = {
  maxOutputTokens: 128_000,
  contextWindowTokens: 1_000_000,
  defaultContextWindowTokens: 200_000,
};

interface FieldOverrides {
  visibility: ProfileParamVisibility;
  maxTokens?: number | null;
  contextWindowMaxInputTokens?: number | null;
  onMaxTokensChange?: (v: number | null) => void;
  onContextWindowChange?: (v: number | null) => void;
  selectedModel?: typeof MODEL;
}

function renderParams(overrides: FieldOverrides) {
  return render(
    <ProfileAdvancedParams
      visibility={overrides.visibility}
      isReadOnly={false}
      model="claude-opus-4"
      selectedModel={overrides.selectedModel ?? MODEL}
      maxTokens={overrides.maxTokens ?? null}
      onMaxTokensChange={overrides.onMaxTokensChange ?? (() => {})}
      contextWindowMaxInputTokens={
        overrides.contextWindowMaxInputTokens ?? null
      }
      onContextWindowChange={overrides.onContextWindowChange ?? (() => {})}
      effort="none"
      onEffortChange={() => {}}
      speed="standard"
      onSpeedChange={() => {}}
      verbosity="low"
      onVerbosityChange={() => {}}
      temperatureEnabled={false}
      onTemperatureEnabledChange={() => {}}
      temperature={1}
      onTemperatureChange={() => {}}
      thinkingEnabled={false}
      onThinkingEnabledChange={() => {}}
      thinkingStreamThinking={false}
      onThinkingStreamThinkingChange={() => {}}
      thinkingLevel="default"
      onThinkingLevelChange={() => {}}
    />,
  );
}

const contextOnly: ProfileParamVisibility = {
  ...VISIBILITY_NONE,
  contextWindow: true,
};
const maxTokensOnly: ProfileParamVisibility = {
  ...VISIBILITY_NONE,
  maxTokens: true,
};

afterEach(() => cleanup());

describe("ProfileAdvancedParams token-budget fields", () => {
  test("shows the resolved default value when no override is set", () => {
    // GIVEN the Context Window field with no override (value === null)
    // AND a model whose applied default is 200K within a 1M window
    renderParams({
      visibility: contextOnly,
      contextWindowMaxInputTokens: null,
    });

    // WHEN the field renders in its default state

    // THEN the resolved default is shown numerically, not as bare "Default"
    expect(screen.getByText("Default · 200K")).toBeTruthy();

    // AND the slider thumb is parked at the resolved default
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe(
      "200000",
    );

    // AND the empty input advertises the resolved default as its placeholder
    const input = screen.getByRole("spinbutton", {
      name: "Context Window (tokens)",
    }) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("200000");
  });

  test("Max Output Tokens reads its default from the resolved schema default, not the model max", () => {
    // GIVEN the Max Output Tokens field with no override
    // AND a model whose max output (128K) exceeds the global schema default
    renderParams({ visibility: maxTokensOnly, maxTokens: null });

    // WHEN the field renders in its default state

    // THEN it surfaces the resolved runtime default (llm.default.maxTokens =
    // 64K) — what the assistant actually uses when maxTokens is unset — rather
    // than the model's higher output ceiling
    expect(screen.getByText("Default · 64K")).toBeTruthy();
    const input = screen.getByRole("spinbutton", {
      name: "Max Output Tokens (tokens)",
    }) as HTMLInputElement;
    expect(input.placeholder).toBe("64000");

    // AND the model's higher ceiling still governs the slider/input maximum
    expect(screen.getByRole("slider").getAttribute("aria-valuemax")).toBe(
      "128000",
    );
  });

  test("Max Output Tokens clamps its default to a model ceiling below the schema default", () => {
    // GIVEN the Max Output Tokens field with no override
    // AND a model whose max output (32K) is below the global schema default
    renderParams({
      visibility: maxTokensOnly,
      maxTokens: null,
      selectedModel: {
        maxOutputTokens: 32_000,
        contextWindowTokens: 1_000_000,
        defaultContextWindowTokens: 200_000,
      },
    });

    // WHEN the field renders in its default state

    // THEN the default is bounded by the model's ceiling so the field never
    // advertises an output budget the model cannot emit
    expect(screen.getByText("Default · 32K")).toBeTruthy();
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuenow")).toBe("32000");
    expect(slider.getAttribute("aria-valuemax")).toBe("32000");
    const input = screen.getByRole("spinbutton", {
      name: "Max Output Tokens (tokens)",
    }) as HTMLInputElement;
    expect(input.placeholder).toBe("32000");
  });

  test("typing an explicit limit commits the parsed value", () => {
    // GIVEN the Context Window field with no override
    const onContextWindowChange = mock();
    renderParams({ visibility: contextOnly, onContextWindowChange });

    // WHEN an in-range value is typed into the numeric input
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Context Window (tokens)" }),
      { target: { value: "128000" } },
    );

    // THEN the explicit value is committed
    expect(onContextWindowChange).toHaveBeenLastCalledWith(128000);
  });

  test("clearing the input restores the model default", () => {
    // GIVEN the Context Window field with an explicit override
    const onContextWindowChange = mock();
    renderParams({
      visibility: contextOnly,
      contextWindowMaxInputTokens: 128_000,
      onContextWindowChange,
    });

    // WHEN the input is cleared
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Context Window (tokens)" }),
      { target: { value: "" } },
    );

    // THEN the override is cleared so the model default applies again
    expect(onContextWindowChange).toHaveBeenLastCalledWith(null);
  });

  test("blurring clamps an above-maximum value down to the model's window", () => {
    // GIVEN the Context Window field with no override
    const onContextWindowChange = mock();
    renderParams({ visibility: contextOnly, onContextWindowChange });
    const input = screen.getByRole("spinbutton", {
      name: "Context Window (tokens)",
    });

    // WHEN a value above the model's window is typed and the input blurs
    fireEvent.change(input, { target: { value: "2000000" } });
    fireEvent.blur(input, { target: { value: "2000000" } });

    // THEN the committed value is clamped down to the model's window
    expect(onContextWindowChange).toHaveBeenLastCalledWith(1000000);
  });

  test("blurring clamps a below-minimum value up to the floor", () => {
    // GIVEN the Context Window field with no override
    const onContextWindowChange = mock();
    renderParams({ visibility: contextOnly, onContextWindowChange });
    const input = screen.getByRole("spinbutton", {
      name: "Context Window (tokens)",
    });

    // WHEN a value below the slider floor is typed and the input blurs
    fireEvent.change(input, { target: { value: "500" } });
    fireEvent.blur(input, { target: { value: "500" } });

    // THEN the committed value is clamped up to the floor
    expect(onContextWindowChange).toHaveBeenLastCalledWith(1000);
  });

  test("Reset clears an explicit override and is disabled at default", () => {
    // GIVEN the Context Window field with an explicit override
    const onContextWindowChange = mock();
    const { rerender } = renderParams({
      visibility: contextOnly,
      contextWindowMaxInputTokens: 128_000,
      onContextWindowChange,
    });
    const reset = screen.getByRole("button", { name: "Reset" });
    expect((reset as HTMLButtonElement).disabled).toBe(false);

    // WHEN Reset is clicked
    fireEvent.click(reset);

    // THEN the override is cleared
    expect(onContextWindowChange).toHaveBeenLastCalledWith(null);

    // AND once the field reads as default, Reset is disabled
    rerender(
      <ProfileAdvancedParams
        visibility={contextOnly}
        isReadOnly={false}
        model="claude-opus-4"
        selectedModel={MODEL}
        maxTokens={null}
        onMaxTokensChange={() => {}}
        contextWindowMaxInputTokens={null}
        onContextWindowChange={onContextWindowChange}
        effort="none"
        onEffortChange={() => {}}
        speed="standard"
        onSpeedChange={() => {}}
        verbosity="low"
        onVerbosityChange={() => {}}
        temperatureEnabled={false}
        onTemperatureEnabledChange={() => {}}
        temperature={1}
        onTemperatureChange={() => {}}
        thinkingEnabled={false}
        onThinkingEnabledChange={() => {}}
        thinkingStreamThinking={false}
        onThinkingStreamThinkingChange={() => {}}
        thinkingLevel="default"
        onThinkingLevelChange={() => {}}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("the slider steps in fine 1,000-token increments", () => {
    // GIVEN the Context Window field at its 200K default within a 1M window
    const onContextWindowChange = mock();
    renderParams({ visibility: contextOnly, onContextWindowChange });

    // WHEN the slider thumb is nudged one step to the right
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });

    // THEN it advances by 1,000 tokens, not a coarse quartile jump
    expect(onContextWindowChange).toHaveBeenLastCalledWith(201000);
  });
});
