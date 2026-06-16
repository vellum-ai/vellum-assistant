/**
 * Tests for the per-turn advisor-tool gate in `conversation-tool-setup.ts`.
 *
 * The advisor tool is registered as an always-on core tool, but it is only
 * exposed to the model when a strictly-more-capable model is configured for
 * the conversation's current executor. The gate is re-evaluated each turn and
 * respects per-conversation profile overrides, so:
 *
 * - executor on a lower tier than the advisor → advisor present / active.
 * - executor == advisor (top tier) → advisor absent / inactive.
 * - a per-turn override that pins a top-tier executor → advisor absent.
 * - a per-turn override that pins a low-tier executor → advisor present.
 *
 * `createResolveToolsCallback` and `isToolActiveForContext` must agree on
 * advisor visibility — the callback filters core tools through the same gate.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as configLoader from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import type { LLMSchema } from "../../config/schemas/llm.js";
import type { ToolDefinition } from "../../providers/types.js";
import { __clearRegistryForTesting } from "../../tools/registry.js";
import {
  createResolveToolsCallback,
  isToolActiveForContext,
} from "../conversation-tool-setup.js";

type SkillProjectionContext =
  import("../conversation-tool-setup.js").SkillProjectionContext;
type SkillProjectionCache =
  import("../conversation-skill-tools.js").SkillProjectionCache;
type LLMConfig = import("zod").z.infer<typeof LLMSchema>;

const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5";

/**
 * Build an `llm` config whose `mainAgent` resolves to `executorModel` and
 * whose `advisor` call-site resolves to `advisorModel`. The advisor call-site
 * points at the `advisor` profile (mirroring the seeded default); the
 * executor model comes from the `mainAgent` call-site override.
 */
function makeLlmConfig(
  executorModel: string,
  advisorModel: string,
  overrideProfiles: Record<string, string> = {},
): LLMConfig {
  return {
    default: { model: executorModel },
    activeProfile: undefined,
    profiles: {
      advisor: { model: advisorModel },
      ...Object.fromEntries(
        Object.entries(overrideProfiles).map(([name, model]) => [
          name,
          { model },
        ]),
      ),
    },
    callSites: {
      mainAgent: { model: executorModel },
      advisor: { profile: "advisor" },
    },
  } as unknown as LLMConfig;
}

function stubConfig(llm: LLMConfig): ReturnType<typeof spyOn> {
  const stub: Partial<AssistantConfig> = {
    llm: llm as AssistantConfig["llm"],
    tools: { exclude: [] },
  };
  return spyOn(configLoader, "getConfig").mockReturnValue(
    stub as AssistantConfig,
  );
}

function makeCtx(
  overrides: Partial<SkillProjectionContext> = {},
): SkillProjectionContext {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: { fingerprints: new Map() } as SkillProjectionCache,
    coreToolNames: new Set<string>(),
    toolsDisabledDepth: 0,
    conversationId: "conv-advisor",
    ...overrides,
  };
}

function def(name: string): ToolDefinition {
  return { name, description: name, input_schema: { type: "object" } };
}

let getConfigSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  __clearRegistryForTesting();
});

afterEach(() => {
  getConfigSpy?.mockRestore();
  getConfigSpy = undefined;
  __clearRegistryForTesting();
});

describe("advisor gate — isToolActiveForContext", () => {
  test("advisor IS active when executor is below the advisor tier (sonnet < opus)", () => {
    getConfigSpy = stubConfig(makeLlmConfig(SONNET, OPUS));
    expect(isToolActiveForContext("advisor", makeCtx())).toBe(true);
  });

  test("advisor IS active when executor is haiku and advisor is opus", () => {
    getConfigSpy = stubConfig(makeLlmConfig(HAIKU, OPUS));
    expect(isToolActiveForContext("advisor", makeCtx())).toBe(true);
  });

  test("advisor is INACTIVE when executor == advisor (opus 4.8)", () => {
    getConfigSpy = stubConfig(makeLlmConfig(OPUS, OPUS));
    expect(isToolActiveForContext("advisor", makeCtx())).toBe(false);
  });

  test("advisor is INACTIVE when config is unavailable (conservative default)", () => {
    getConfigSpy = spyOn(configLoader, "getConfig").mockImplementation(() => {
      throw new Error("config not loaded");
    });
    expect(isToolActiveForContext("advisor", makeCtx())).toBe(false);
  });

  test("non-advisor core tools are unaffected by the gate", () => {
    getConfigSpy = stubConfig(makeLlmConfig(OPUS, OPUS));
    expect(isToolActiveForContext("file_read", makeCtx())).toBe(true);
  });
});

describe("advisor gate — per-turn override re-evaluation", () => {
  test("a top-tier override hides the advisor even when the default executor is lower", () => {
    // Default executor is sonnet (below advisor), but this turn pins a
    // top-tier override profile, so the advisor must be hidden.
    getConfigSpy = stubConfig(makeLlmConfig(SONNET, OPUS, { topTier: OPUS }));
    expect(
      isToolActiveForContext(
        "advisor",
        makeCtx({ currentTurnOverrideProfile: "topTier" }),
      ),
    ).toBe(false);
  });

  test("a low-tier override shows the advisor even when the default executor is top tier", () => {
    // Default executor is opus (== advisor), but this turn pins a low-tier
    // override profile, so the advisor must be exposed.
    getConfigSpy = stubConfig(makeLlmConfig(OPUS, OPUS, { lowTier: HAIKU }));
    expect(
      isToolActiveForContext(
        "advisor",
        makeCtx({ currentTurnOverrideProfile: "lowTier" }),
      ),
    ).toBe(true);
  });
});

describe("advisor gate — createResolveToolsCallback agreement", () => {
  test("advisor is present in the resolved tool list when below tier", () => {
    getConfigSpy = stubConfig(makeLlmConfig(SONNET, OPUS));
    const resolver = createResolveToolsCallback(
      [def("advisor"), def("file_read")],
      makeCtx(),
    );
    const names = resolver!([]).map((d) => d.name);
    expect(names).toContain("advisor");
    expect(names).toContain("file_read");
  });

  test("advisor is absent from the resolved tool list when at tier", () => {
    getConfigSpy = stubConfig(makeLlmConfig(OPUS, OPUS));
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback(
      [def("advisor"), def("file_read")],
      ctx,
    );
    const names = resolver!([]).map((d) => d.name);
    expect(names).not.toContain("advisor");
    expect(names).toContain("file_read");
    // The per-turn execution allowlist must agree with the wire list.
    expect(ctx.allowedToolNames?.has("advisor")).toBe(false);
  });

  test("callback and isToolActiveForContext agree on advisor visibility", () => {
    getConfigSpy = stubConfig(makeLlmConfig(OPUS, OPUS));
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback([def("advisor")], ctx);
    const inList = resolver!([]).some((d) => d.name === "advisor");
    expect(inList).toBe(isToolActiveForContext("advisor", ctx));
  });
});
