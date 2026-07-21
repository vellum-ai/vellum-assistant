/**
 * Tests for the token-budget controls (Max Output Tokens / Context Window) in
 * `ProfileAdvancedParams`:
 *
 *   1. With no override set, the field surfaces the resolved default
 *      numerically — a "Default · NNN" label, the slider thumb parked at the
 *      resolved value, and the same value as the input's placeholder — instead
 *      of hiding it behind the bare word "Default". Each field's default is the
 *      value a profile inherits from `llm.default` (Max Output from
 *      `maxTokens`, Context Window from `contextWindow.maxInputTokens`) — the
 *      explicitly-configured value when the config sets one, otherwise the
 *      schema default (64K / 200K) — clamped to the model's hard ceiling so it
 *      never advertises a budget the model can't honor.
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
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import {
  type ProfileParamVisibility,
  VISIBILITY_NONE,
} from "@/domains/settings/ai/profile-param-visibility";

const MODEL = {
  maxOutputTokens: 128_000,
  contextWindowTokens: 1_000_000,
};

interface FieldOverrides {
  visibility: ProfileParamVisibility;
  isReadOnly?: boolean;
  maxTokens?: number | null;
  contextWindowMaxInputTokens?: number | null;
  onMaxTokensChange?: (v: number | null) => void;
  onContextWindowChange?: (v: number | null) => void;
  selectedModel?: typeof MODEL;
  defaultMaxOutputTokens?: number;
  defaultContextWindowMaxInputTokens?: number;
  topPEnabled?: boolean;
  onTopPEnabledChange?: (v: boolean) => void;
  topP?: number;
  onTopPChange?: (v: number) => void;
  onEffortChange?: (v: string) => void;
  onSpeedChange?: (v: string) => void;
}

function renderParams(overrides: FieldOverrides) {
  return render(
    <ProfileAdvancedParams
      visibility={overrides.visibility}
      isReadOnly={overrides.isReadOnly ?? false}
      model="claude-opus-4"
      selectedModel={overrides.selectedModel ?? MODEL}
      defaultMaxOutputTokens={overrides.defaultMaxOutputTokens}
      defaultContextWindowMaxInputTokens={
        overrides.defaultContextWindowMaxInputTokens
      }
      maxTokens={overrides.maxTokens ?? null}
      onMaxTokensChange={overrides.onMaxTokensChange ?? (() => {})}
      contextWindowMaxInputTokens={
        overrides.contextWindowMaxInputTokens ?? null
      }
      onContextWindowChange={overrides.onContextWindowChange ?? (() => {})}
      effort="none"
      onEffortChange={overrides.onEffortChange ?? (() => {})}
      speed="standard"
      onSpeedChange={overrides.onSpeedChange ?? (() => {})}
      verbosity="low"
      onVerbosityChange={() => {}}
      temperatureEnabled={false}
      onTemperatureEnabledChange={() => {}}
      temperature={1}
      onTemperatureChange={() => {}}
      topPEnabled={overrides.topPEnabled ?? false}
      onTopPEnabledChange={overrides.onTopPEnabledChange ?? (() => {})}
      topP={overrides.topP ?? 1}
      onTopPChange={overrides.onTopPChange ?? (() => {})}
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
    // AND no configured llm.default, so the 200K schema fallback applies
    // within the model's 1M window
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

  test("Max Output Tokens honors a configured llm.default.maxTokens above the schema default", () => {
    // GIVEN the Max Output Tokens field with no override
    // AND a workspace whose llm.default.maxTokens (128K) is set above the
    // schema default, with a model whose ceiling can hold it
    renderParams({
      visibility: maxTokensOnly,
      maxTokens: null,
      defaultMaxOutputTokens: 128_000,
    });

    // WHEN the field renders in its default state

    // THEN it surfaces the configured inherited default rather than the 64K
    // schema fallback
    expect(screen.getByText("Default · 128K")).toBeTruthy();
    const input = screen.getByRole("spinbutton", {
      name: "Max Output Tokens (tokens)",
    }) as HTMLInputElement;
    expect(input.placeholder).toBe("128000");
  });

  test("Max Output Tokens clamps a configured llm.default.maxTokens to the model ceiling", () => {
    // GIVEN the Max Output Tokens field with no override
    // AND a configured llm.default.maxTokens (128K) above a model whose
    // ceiling (32K) cannot emit it
    renderParams({
      visibility: maxTokensOnly,
      maxTokens: null,
      defaultMaxOutputTokens: 128_000,
      selectedModel: {
        maxOutputTokens: 32_000,
        contextWindowTokens: 1_000_000,
      },
    });

    // WHEN the field renders in its default state

    // THEN the configured default is still bounded by the model's ceiling
    expect(screen.getByText("Default · 32K")).toBeTruthy();
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe(
      "32000",
    );
  });

  test("Context Window honors a configured llm.default.contextWindow.maxInputTokens", () => {
    // GIVEN the Context Window field with no override
    // AND a workspace whose llm.default.contextWindow.maxInputTokens (150K) is
    // set, with a model window large enough to hold it
    renderParams({
      visibility: contextOnly,
      contextWindowMaxInputTokens: null,
      defaultContextWindowMaxInputTokens: 150_000,
    });

    // WHEN the field renders in its default state

    // THEN it surfaces the configured inherited default rather than the 200K
    // schema fallback
    expect(screen.getByText("Default · 150K")).toBeTruthy();
    const input = screen.getByRole("spinbutton", {
      name: "Context Window (tokens)",
    }) as HTMLInputElement;
    expect(input.placeholder).toBe("150000");
  });

  test("Context Window clamps a configured maxInputTokens to the model window", () => {
    // GIVEN the Context Window field with no override
    // AND a configured llm.default.contextWindow.maxInputTokens (2M) above the
    // model's window (1M)
    renderParams({
      visibility: contextOnly,
      contextWindowMaxInputTokens: null,
      defaultContextWindowMaxInputTokens: 2_000_000,
    });

    // WHEN the field renders in its default state

    // THEN the configured default is bounded by the model's window
    expect(screen.getByText("Default · 1M")).toBeTruthy();
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuenow")).toBe("1000000");
    expect(slider.getAttribute("aria-valuemax")).toBe("1000000");
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
        topPEnabled={false}
        onTopPEnabledChange={() => {}}
        topP={1}
        onTopPChange={() => {}}
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

const topPOnly: ProfileParamVisibility = {
  ...VISIBILITY_NONE,
  topP: true,
};

describe("ProfileAdvancedParams Top P control", () => {
  test("renders the Top P toggle when visibility.topP is true", () => {
    renderParams({ visibility: topPOnly });

    expect(screen.getByRole("switch", { name: "Top P" })).toBeTruthy();
  });

  test("does not render the Top P control when visibility.topP is false", () => {
    renderParams({ visibility: maxTokensOnly });

    expect(screen.queryByRole("switch", { name: "Top P" })).toBeNull();
  });

  test("toggling Top P invokes onTopPEnabledChange", () => {
    const onTopPEnabledChange = mock();
    renderParams({ visibility: topPOnly, onTopPEnabledChange });

    fireEvent.click(screen.getByRole("switch", { name: "Top P" }));

    expect(onTopPEnabledChange).toHaveBeenLastCalledWith(true);
  });

  test("the slider only renders once Top P is enabled", () => {
    const { rerender } = renderParams({ visibility: topPOnly });

    expect(screen.queryByRole("slider")).toBeNull();

    rerender(
      <ProfileAdvancedParams
        visibility={topPOnly}
        isReadOnly={false}
        model="claude-opus-4"
        selectedModel={MODEL}
        maxTokens={null}
        onMaxTokensChange={() => {}}
        contextWindowMaxInputTokens={null}
        onContextWindowChange={() => {}}
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
        topPEnabled={true}
        onTopPEnabledChange={() => {}}
        topP={0.9}
        onTopPChange={() => {}}
        thinkingEnabled={false}
        onThinkingEnabledChange={() => {}}
        thinkingStreamThinking={false}
        onThinkingStreamThinkingChange={() => {}}
        thinkingLevel="default"
        onThinkingLevelChange={() => {}}
      />,
    );
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("1");
    expect(slider.getAttribute("aria-valuenow")).toBe("0.9");
  });

  test("sliding Top P invokes onTopPChange", () => {
    const onTopPChange = mock();
    renderParams({
      visibility: topPOnly,
      topPEnabled: true,
      topP: 0.9,
      onTopPChange,
    });

    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });

    expect(onTopPChange).toHaveBeenCalled();
  });

  test("locks the Top P toggle when read-only", () => {
    // GIVEN read-only params with Top P visible
    const onTopPEnabledChange = mock();
    renderParams({
      visibility: topPOnly,
      isReadOnly: true,
      onTopPEnabledChange,
    });

    // THEN the Top P toggle inherits the locked read-only state.
    const toggle = screen.getByRole("switch", {
      name: "Top P",
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });
});

const effortAndSpeed: ProfileParamVisibility = {
  ...VISIBILITY_NONE,
  effort: true,
  speed: true,
};

describe("ProfileAdvancedParams read-only segment controls", () => {
  test("disables every Effort and Speed segment when read-only", () => {
    // GIVEN a locked (read-only) profile — e.g. an invariant managed
    // profile — with Effort and Speed visible
    const onEffortChange = mock();
    const onSpeedChange = mock();
    renderParams({
      visibility: effortAndSpeed,
      isReadOnly: true,
      onEffortChange,
      onSpeedChange,
    });

    // THEN every segment in both controls is disabled, so the controls cannot
    // even change local UI state
    const segments = screen.getAllByRole("radio") as HTMLButtonElement[];
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.disabled).toBe(true);
    }

    // AND clicking a non-selected segment fires no change handler
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    expect(onEffortChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "fast" }));
    expect(onSpeedChange).not.toHaveBeenCalled();
  });

  test("keeps Effort and Speed segments interactive when editable", () => {
    // GIVEN an editable profile with Effort and Speed visible
    const onEffortChange = mock();
    const onSpeedChange = mock();
    renderParams({
      visibility: effortAndSpeed,
      isReadOnly: false,
      onEffortChange,
      onSpeedChange,
    });

    // THEN no segment is disabled and clicks commit the new value
    const segments = screen.getAllByRole("radio") as HTMLButtonElement[];
    for (const segment of segments) {
      expect(segment.disabled).toBe(false);
    }
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    expect(onEffortChange).toHaveBeenLastCalledWith("high");
    fireEvent.click(screen.getByRole("radio", { name: "fast" }));
    expect(onSpeedChange).toHaveBeenLastCalledWith("fast");
  });
});

// ---------------------------------------------------------------------------
// M7 PR 5 — snapshot copy is version-gated (write-time completion is 0.10.8+)
// ---------------------------------------------------------------------------

describe("snapshot helper copy", () => {
  const SNAPSHOT_COPY = "saved with the values shown";

  afterEach(() => {
    useAssistantIdentityStore.getState().clearIdentity();
  });

  test("renders on assistants with write-time completion (0.10.8+)", () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.8");
    renderParams({ visibility: maxTokensOnly });
    expect(document.body.textContent).toContain(SNAPSHOT_COPY);
  });

  test("hidden against pre-0.10.8 assistants (blanks still live-inherit there)", () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.7");
    renderParams({ visibility: maxTokensOnly });
    expect(document.body.textContent).not.toContain(SNAPSHOT_COPY);
  });

  test("hidden in read-only view mode", () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.8");
    renderParams({ visibility: maxTokensOnly, isReadOnly: true });
    expect(document.body.textContent).not.toContain(SNAPSHOT_COPY);
  });
});
