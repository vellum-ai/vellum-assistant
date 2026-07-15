import { describe, expect, test } from "bun:test";

import { DEFAULT_PRECHAT_INITIAL_MESSAGE } from "@/domains/onboarding/prechat";
import {
  ACTIVATION_FLOW_COHORT,
  ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE,
  buildPreChatContext,
  type BuildPreChatContextInput,
} from "@/domains/onboarding/prechat-context";

function baseInput(
  overrides: Partial<BuildPreChatContextInput> = {},
): BuildPreChatContextInput {
  return {
    mode: "control",
    recipe: null,
    selectedTools: new Set(),
    selectedTasks: new Set(),
    selectedPriorAssistants: new Set(),
    tone: "balanced",
    userName: "Alice",
    assistantName: "Vela",
    selfIntroGreetingEnabled: false,
    googleConnected: false,
    googleScopes: [],
    ...overrides,
  };
}

describe("buildPreChatContext — activation rail", () => {
  test("selects the activation bootstrap template when the experiment flag is on", () => {
    const context = buildPreChatContext(
      baseInput({ activationFlowEnabled: true }),
    );

    expect(context.cohort).toBe(ACTIVATION_FLOW_COHORT);
    expect(context.bootstrapTemplate).toBe(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE);
  });

  test("activation template wins over a marketing recipe template", () => {
    const context = buildPreChatContext(
      baseInput({
        activationFlowEnabled: true,
        recipe: {
          cohort: "content-automation",
          bootstrapTemplate: "BOOTSTRAP-CONTENT-AUTOMATION.md",
          initialMessage: "Campaign hello",
          skills: ["geo-writing"],
        } as BuildPreChatContextInput["recipe"],
      }),
    );

    expect(context.cohort).toBe(ACTIVATION_FLOW_COHORT);
    expect(context.bootstrapTemplate).toBe(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE);
    expect(context.skills).toEqual(["geo-writing"]);
    expect(context.initialMessage).toBe(DEFAULT_PRECHAT_INITIAL_MESSAGE);
  });
});

describe("buildPreChatContext — control", () => {
  test("carries tools, sorted tasks, names, and tone", () => {
    const context = buildPreChatContext(
      baseInput({
        selectedTools: new Set(["gmail", "other:custom"]),
        selectedTasks: new Set(["b", "a"]),
      }),
    );
    expect(context.tasks).toEqual(["a", "b"]);
    expect(context.tone).toBe("balanced");
    expect(context.userName).toBe("Alice");
    expect(context.assistantName).toBe("Vela");
    expect(context.googleConnected).toBe(false);
  });

  test("records prior assistants when selected", () => {
    const context = buildPreChatContext(
      baseInput({ selectedPriorAssistants: new Set(["asst-1"]) }),
    );
    expect(context.priorAssistants).toEqual(["asst-1"]);
  });

  test("carries a trimmed occupation when provided", () => {
    const context = buildPreChatContext(
      baseInput({ occupation: "  Software Engineer  " }),
    );
    expect(context.occupation).toBe("Software Engineer");
  });

  test("omits occupation when absent or blank", () => {
    expect(buildPreChatContext(baseInput()).occupation).toBeUndefined();
    expect(
      buildPreChatContext(baseInput({ occupation: "   " })).occupation,
    ).toBeUndefined();
  });

  test("uses scopes from the connecting action over stored state", () => {
    const context = buildPreChatContext(
      baseInput({
        googleConnected: false,
        googleScopes: ["stale"],
        connectedScopes: ["gmail.readonly"],
      }),
    );
    expect(context.googleConnected).toBe(true);
    expect(context.googleScopes).toEqual(["gmail.readonly"]);
  });

  test("falls back to previously stored Google connection", () => {
    const context = buildPreChatContext(
      baseInput({ googleConnected: true, googleScopes: ["gmail.send"] }),
    );
    expect(context.googleConnected).toBe(true);
    expect(context.googleScopes).toEqual(["gmail.send"]);
  });
});

describe("buildPreChatContext — native", () => {
  test("collects only name, tone, and a self-intro message", () => {
    const context = buildPreChatContext(
      baseInput({
        mode: "native",
        // Selections from other flows must not leak into the native payload.
        selectedTools: new Set(["gmail"]),
        selectedTasks: new Set(["a"]),
        selectedPriorAssistants: new Set(["asst-1"]),
        selfIntroGreetingEnabled: true,
      }),
    );
    expect(context.tools).toEqual([]);
    expect(context.tasks).toEqual([]);
    expect(context.googleConnected).toBe(false);
    expect(context.priorAssistants).toBeUndefined();
    expect(context.userName).toBe("Alice");
    expect(context.initialMessage).toBe("Hi Vela, I'm Alice. Nice to meet you.");
  });
});

describe("buildPreChatContext — initial message", () => {
  test("a recipe message wins over the generated greeting", () => {
    const context = buildPreChatContext(
      baseInput({
        selfIntroGreetingEnabled: true,
        recipe: {
          initialMessage: "Campaign hello",
        } as BuildPreChatContextInput["recipe"],
      }),
    );
    expect(context.initialMessage).toBe("Campaign hello");
  });

  test("default message when the self-intro greeting is off", () => {
    const context = buildPreChatContext(
      baseInput({ selfIntroGreetingEnabled: false }),
    );
    expect(context.initialMessage).not.toBe(
      "Hi Vela, I'm Alice. Nice to meet you.",
    );
  });
});
