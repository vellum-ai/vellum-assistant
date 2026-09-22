/**
 * Availability of `send_user_message` on the per-turn tool surface: the flag
 * must be on AND the turn must be a main-agent turn. Subagents, calls,
 * live-voice legs, and background workers keep streamed assistant text, so the
 * tool never appears for them.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as featureFlags from "../../config/assistant-feature-flags.js";
import * as configLoader from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import { SEND_USER_MESSAGE_TOOL_NAME } from "../../config/send-user-message-constants.js";
import type { ToolDefinition } from "../../providers/types.js";
import { __clearRegistryForTesting } from "../../tools/registry.js";
import { declareDaemonActivityField } from "../../tools/schema-transforms.js";
import type { Conversation } from "../conversation.js";
import {
  createResolveToolsCallback,
  isToolActiveForContext,
} from "../conversation-tool-setup.js";

type SkillProjectionCache =
  import("../conversation-skill-tools.js").SkillProjectionCache;

let flagSpy: ReturnType<typeof spyOn> | undefined;

function setFlag(enabled: boolean): void {
  flagSpy = spyOn(
    featureFlags,
    "isAssistantFeatureFlagEnabled",
  ).mockImplementation((key: string) =>
    key === "send-user-message" ? enabled : false,
  );
}

function ctx(overrides: Partial<Conversation> = {}): Conversation {
  return {
    toolsDisabledDepth: 0,
    hasNoClient: false,
    ...overrides,
  } as unknown as Conversation;
}

afterEach(() => {
  flagSpy?.mockRestore();
  flagSpy = undefined;
});

describe("send_user_message tool availability", () => {
  test("is unavailable when the flag is off", () => {
    setFlag(false);
    expect(isToolActiveForContext(SEND_USER_MESSAGE_TOOL_NAME, ctx())).toBe(
      false,
    );
  });

  test("is available on a main-agent turn when the flag is on", () => {
    setFlag(true);
    expect(
      isToolActiveForContext(
        SEND_USER_MESSAGE_TOOL_NAME,
        ctx({ currentCallSite: "mainAgent" }),
      ),
    ).toBe(true);
  });

  test("is available on a turn with no resolved call site", () => {
    setFlag(true);
    expect(isToolActiveForContext(SEND_USER_MESSAGE_TOOL_NAME, ctx())).toBe(
      true,
    );
  });

  test("is unavailable to a subagent", () => {
    setFlag(true);
    expect(
      isToolActiveForContext(
        SEND_USER_MESSAGE_TOOL_NAME,
        ctx({ isSubagent: true, currentCallSite: "mainAgent" }),
      ),
    ).toBe(false);
  });

  test("is unavailable to calls, live-voice, and worker call sites", () => {
    setFlag(true);
    for (const callSite of [
      "callAgent",
      "voiceFrontDoor",
      "subagentSpawn",
      "heartbeatAgent",
      "memoryConsolidation",
    ] as const) {
      expect(
        isToolActiveForContext(
          SEND_USER_MESSAGE_TOOL_NAME,
          ctx({ currentCallSite: callSite }),
        ),
      ).toBe(false);
    }
  });
});

describe("send_user_message under disk-pressure cleanup", () => {
  test("stays available on a gated cleanup turn", () => {
    // Cleanup mode narrows the surface to tools that free space, but this one
    // consumes nothing and is the only channel a gated turn can reach the user
    // through. Withholding it would leave the model under a prompt naming a
    // tool it does not have, spend the empty-response nudge asking for it, and
    // fall through to raw text.
    setFlag(true);
    expect(
      isToolActiveForContext(
        SEND_USER_MESSAGE_TOOL_NAME,
        ctx({
          currentCallSite: "mainAgent",
          diskPressureCleanupModeActive: true,
        }),
      ),
    ).toBe(true);
  });

  test("stays off a cleanup turn that was never gated", () => {
    setFlag(false);
    expect(
      isToolActiveForContext(
        SEND_USER_MESSAGE_TOOL_NAME,
        ctx({
          currentCallSite: "mainAgent",
          diskPressureCleanupModeActive: true,
        }),
      ),
    ).toBe(false);
  });

  test("does not widen cleanup mode for anything else", () => {
    setFlag(true);
    const cleanupCtx = ctx({
      currentCallSite: "mainAgent",
      diskPressureCleanupModeActive: true,
    });
    expect(isToolActiveForContext("web_search", cleanupCtx)).toBe(false);
    expect(isToolActiveForContext("file_read", cleanupCtx)).toBe(true);
  });
});

describe("send_user_message on a tool-disabled turn", () => {
  test("the gate is off, so nothing is suppressed for a turn with no tools", async () => {
    // Pointer generation (call-status events) and the live-voice front-door leg
    // bracket themselves with `toolsDisabledDepth` while keeping the mainAgent
    // call site. The resolver hands them an empty tool list, so gating them
    // would suppress their text and name a tool they were never given: the
    // reply would reach the user only after a wasted nudge and the fallback.
    setFlag(true);
    const { isSendUserMessageActiveForTurn } =
      await import("../../config/send-user-message-gate.js");

    expect(
      isSendUserMessageActiveForTurn({
        currentCallSite: "mainAgent",
        toolsDisabledDepth: 1,
      }),
    ).toBe(false);
    // The same turn with its bracket released is gated again.
    expect(
      isSendUserMessageActiveForTurn({
        currentCallSite: "mainAgent",
        toolsDisabledDepth: 0,
      }),
    ).toBe(true);
  });

  test("the tool is off that turn's surface either way", () => {
    setFlag(true);
    expect(
      isToolActiveForContext(
        SEND_USER_MESSAGE_TOOL_NAME,
        ctx({ currentCallSite: "mainAgent", toolsDisabledDepth: 1 }),
      ),
    ).toBe(false);
  });
});

describe("send_user_message excluded by workspace config", () => {
  test("the gate is off, so nothing is suppressed and no section renders", async () => {
    // `tools.exclude` drops the name from the definitions the model is given.
    // Gating the turn anyway would tell it its plain text is invisible and
    // hand it no way to speak.
    setFlag(true);
    const configLoader = await import("../../config/loader.js");
    const { isSendUserMessageActiveForTurn } =
      await import("../../config/send-user-message-gate.js");
    const configSpy = spyOn(configLoader, "getConfig").mockReturnValue({
      tools: { exclude: [SEND_USER_MESSAGE_TOOL_NAME] },
    } as never);

    try {
      expect(
        isSendUserMessageActiveForTurn({ currentCallSite: "mainAgent" }),
      ).toBe(false);
    } finally {
      configSpy.mockRestore();
    }
  });

  test("an unrelated exclusion leaves the gate alone", async () => {
    setFlag(true);
    const configLoader = await import("../../config/loader.js");
    const { isSendUserMessageActiveForTurn } =
      await import("../../config/send-user-message-gate.js");
    const configSpy = spyOn(configLoader, "getConfig").mockReturnValue({
      tools: { exclude: ["bash"] },
    } as never);

    try {
      expect(
        isSendUserMessageActiveForTurn({ currentCallSite: "mainAgent" }),
      ).toBe(true);
    } finally {
      configSpy.mockRestore();
    }
  });
});

describe("the advertised activity field", () => {
  /** A tool whose schema the daemon owns, alongside one it does not. */
  function activityDefs(): ToolDefinition[] {
    return [
      {
        name: "plain_tool",
        description: "plain",
        input_schema: {
          type: "object",
          properties: { foo: { type: "string" } },
        },
      },
      {
        name: "file_read",
        description: "daemon-owned",
        input_schema: declareDaemonActivityField({
          type: "object",
          properties: {
            path: { type: "string" },
            activity: { type: "string", description: "status" },
          },
          required: ["path", "activity"],
        }),
      },
    ];
  }

  function resolveAdvertised(): ToolDefinition[] {
    const resolver = createResolveToolsCallback(
      activityDefs(),
      ctx({
        currentCallSite: "mainAgent",
        skillProjectionState: new Map(),
        skillProjectionCache: {
          fingerprints: new Map(),
        } as SkillProjectionCache,
      } as Partial<Conversation>),
    );
    expect(resolver).toBeDefined();
    return resolver?.([]) ?? [];
  }

  function hasActivity(def: ToolDefinition): boolean {
    const schema = def.input_schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown> | undefined;
    return properties !== undefined && "activity" in properties;
  }

  let configSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    __clearRegistryForTesting();
    const stub: Partial<AssistantConfig> = { tools: { exclude: [] } };
    configSpy = spyOn(configLoader, "getConfig").mockReturnValue(
      stub as AssistantConfig,
    );
  });

  afterEach(() => {
    configSpy?.mockRestore();
    configSpy = undefined;
    __clearRegistryForTesting();
  });

  test("is absent from every definition when the flag is on", () => {
    // The gated client renders no tool activity text, so the field is dead
    // weight that also reads as a second channel to the user.
    setFlag(true);
    const defs = resolveAdvertised();
    expect(defs.length).toBe(2);
    expect(defs.some(hasActivity)).toBe(false);
    const owned = defs.find((d) => d.name === "file_read");
    expect((owned?.input_schema as Record<string, unknown>).required).toEqual([
      "path",
    ]);
  });

  test("is on every definition when the flag is off", () => {
    setFlag(false);
    const defs = resolveAdvertised();
    expect(defs.length).toBe(2);
    expect(defs.every(hasActivity)).toBe(true);
  });
});
