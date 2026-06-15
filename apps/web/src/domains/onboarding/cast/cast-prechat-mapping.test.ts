import { describe, expect, test } from "bun:test";

import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";
import {
  ACTIVATION_FLOW_COHORT,
  ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE,
} from "@/domains/onboarding/prechat-context";
import {
  buildCastPreChatContext,
  CAST_RESEARCH_DIRECTIVE,
  type CastSelections,
} from "@/domains/onboarding/cast/cast-prechat-mapping";

function baseSelections(
  overrides: Partial<CastSelections> = {},
): CastSelections {
  return {
    firstName: "Alex",
    lastName: "Nork",
    role: "Founder",
    jobs: [],
    reachTools: [],
    ...overrides,
  };
}

describe("buildCastPreChatContext", () => {
  test("maps first + last name into userName", () => {
    const context = buildCastPreChatContext(baseSelections());
    expect(context.userName).toBe("Alex Nork");
  });

  test("joins only the present name parts", () => {
    expect(
      buildCastPreChatContext(
        baseSelections({ firstName: "Alex", lastName: undefined }),
      ).userName,
    ).toBe("Alex");
    expect(
      buildCastPreChatContext(
        baseSelections({ firstName: undefined, lastName: "Nork" }),
      ).userName,
    ).toBe("Nork");
  });

  test("maps role into occupation", () => {
    const context = buildCastPreChatContext(
      baseSelections({ role: "Software Engineer" }),
    );
    expect(context.occupation).toBe("Software Engineer");
  });

  test("trims occupation", () => {
    const context = buildCastPreChatContext(
      baseSelections({ role: "  Designer  " }),
    );
    expect(context.occupation).toBe("Designer");
  });

  test("omits occupation when role is blank", () => {
    const context = buildCastPreChatContext(baseSelections({ role: "   " }));
    expect(context.occupation).toBeUndefined();
  });

  test("omits occupation when role is absent", () => {
    const context = buildCastPreChatContext(
      baseSelections({ role: undefined }),
    );
    expect(context.occupation).toBeUndefined();
  });

  test("maps jobs into tasks", () => {
    const context = buildCastPreChatContext(
      baseSelections({ jobs: ["writing", "research"] }),
    );
    expect(context.tasks).toEqual(["research", "writing"]);
  });

  test("maps reachTools into tools", () => {
    const context = buildCastPreChatContext(
      baseSelections({ reachTools: ["slack", "linear"] }),
    );
    expect(context.tools).toEqual(expect.arrayContaining(["slack", "linear"]));
    expect(context.tools).toHaveLength(2);
  });

  test("maps prior assistant into priorAssistants", () => {
    const context = buildCastPreChatContext(
      baseSelections({ priorAssistant: "chatgpt" }),
    );
    expect(context.priorAssistants).toEqual(["chatgpt"]);
  });

  test("omits priorAssistants when no prior assistant", () => {
    const context = buildCastPreChatContext(
      baseSelections({ priorAssistant: undefined }),
    );
    expect(context.priorAssistants).toBeUndefined();
  });

  test("uses provided tone", () => {
    const context = buildCastPreChatContext(
      baseSelections({ tone: "warm" }),
    );
    expect(context.tone).toBe("warm");
  });

  test("falls back to the default group id when tone is absent", () => {
    const context = buildCastPreChatContext(
      baseSelections({ tone: undefined }),
    );
    expect(context.tone).toBe(DEFAULT_GROUP_ID);
  });

  test("overrides initialMessage with the research directive", () => {
    const context = buildCastPreChatContext(baseSelections());
    expect(context.initialMessage).toBe(CAST_RESEARCH_DIRECTIVE);
  });

  test("carries the activation cohort and bootstrap template", () => {
    const context = buildCastPreChatContext(baseSelections());
    expect(context.cohort).toBe(ACTIVATION_FLOW_COHORT);
    expect(context.bootstrapTemplate).toBe(ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE);
  });
});
