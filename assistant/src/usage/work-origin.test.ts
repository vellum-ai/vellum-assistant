import { describe, expect, test } from "bun:test";

import {
  classifyWorkOrigin,
  type WorkOrigin,
  type WorkOriginInput,
} from "./work-origin.js";

const base: WorkOriginInput = {
  conversationType: null,
  conversationSource: null,
  callSite: null,
  parentConversationId: null,
};

function input(overrides: Partial<WorkOriginInput>): WorkOriginInput {
  return { ...base, ...overrides };
}

describe("classifyWorkOrigin", () => {
  const cases: Array<{
    name: string;
    input: WorkOriginInput;
    expected: WorkOrigin;
  }> = [
    // 1. Delegated child: parent linkage present, whatever else is set.
    {
      name: "subagent spawn (parent + background) maps to delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "subagent",
        callSite: "mainAgent",
        parentConversationId: "conv-parent-1",
      }),
      expected: "delegated_child",
    },
    {
      name: "retrospective fork (parent resolved, memory call site) maps to delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "memory-retrospective",
        callSite: "memoryRetrospective",
        parentConversationId: "conv-source-1",
      }),
      expected: "delegated_child",
    },
    {
      name: "parent linkage wins over a scheduled type",
      input: input({
        conversationType: "scheduled",
        conversationSource: "schedule",
        parentConversationId: "conv-parent-2",
      }),
      expected: "delegated_child",
    },
    // 2. Delegated child recovered from the record-time source when the
    // spawning conversation was deleted before flush.
    {
      name: "deleted-parent retrospective fork (stamped source, no parent) maps to delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "memory-retrospective-fork",
        callSite: "memoryRetrospective",
      }),
      expected: "delegated_child",
    },
    {
      name: "deleted-parent legacy retrospective (stamped source, no parent) maps to delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "memory-retrospective",
        callSite: "memoryRetrospective",
      }),
      expected: "delegated_child",
    },
    {
      name: "deleted-parent subagent conversation (stamped source, no parent) maps to delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "subagent",
        callSite: "mainAgent",
      }),
      expected: "delegated_child",
    },
    {
      name: "stamped spawn source wins over a scheduled type when parent linkage is gone",
      input: input({
        conversationType: "scheduled",
        conversationSource: "subagent",
      }),
      expected: "delegated_child",
    },
    // 3. Schedule origin.
    {
      name: "scheduled conversation maps to user_created_schedule",
      input: input({
        conversationType: "scheduled",
        conversationSource: "schedule",
        callSite: "mainAgent",
      }),
      expected: "user_created_schedule",
    },
    {
      name: "scheduled type alone maps to user_created_schedule",
      input: input({ conversationType: "scheduled", callSite: "mainAgent" }),
      expected: "user_created_schedule",
    },
    {
      name: "scheduled wins over a memory call site",
      input: input({
        conversationType: "scheduled",
        conversationSource: "schedule",
        callSite: "recall",
      }),
      expected: "user_created_schedule",
    },
    {
      name: "manually run schedule (schedule source, standard type) maps to user_created_schedule",
      input: input({
        conversationType: "standard",
        conversationSource: "schedule",
        callSite: "mainAgent",
      }),
      expected: "user_created_schedule",
    },
    // 4. Heartbeat.
    {
      name: "heartbeat call site alone maps to heartbeat",
      input: input({ callSite: "heartbeatAgent" }),
      expected: "heartbeat",
    },
    {
      name: "heartbeat source alone maps to heartbeat",
      input: input({
        conversationType: "background",
        conversationSource: "heartbeat",
        callSite: "mainAgent",
      }),
      expected: "heartbeat",
    },
    {
      name: "heartbeat call site wins over a memory source",
      input: input({
        conversationType: "background",
        conversationSource: "filing",
        callSite: "heartbeatAgent",
      }),
      expected: "heartbeat",
    },
    // 5. Memory maintenance: every dedicated call site.
    ...(
      [
        "memoryExtraction",
        "memoryConsolidation",
        "memoryRetrieval",
        "memoryV2Migration",
        "memoryV2Sweep",
        "memoryRouter",
        "memoryV3SelectL2",
        "memoryV2Consolidation",
        "memoryRetrospective",
        "recall",
        "filingAgent",
      ] as const
    ).map((callSite) => ({
      name: `${callSite} call site maps to memory_maintenance`,
      input: input({ callSite }),
      expected: "memory_maintenance" as WorkOrigin,
    })),
    {
      name: "recall inside a standard user conversation maps to memory_maintenance (call site wins over user_interactive)",
      input: input({
        conversationType: "standard",
        conversationSource: "user",
        callSite: "recall",
      }),
      expected: "memory_maintenance",
    },
    {
      name: "memory consolidation with no conversation maps to memory_maintenance",
      input: input({ callSite: "memoryConsolidation" }),
      expected: "memory_maintenance",
    },
    // 5b. Memory maintenance: every dedicated conversation source.
    ...(["memory_v2_consolidation", "filing", "memory"] as const).map(
      (conversationSource) => ({
        name: `${conversationSource} source maps to memory_maintenance`,
        input: input({
          conversationType: "background",
          conversationSource,
          callSite: "mainAgent",
        }),
        expected: "memory_maintenance" as WorkOrigin,
      }),
    ),
    // 6. User interactive.
    {
      name: "standard user conversation maps to user_interactive",
      input: input({
        conversationType: "standard",
        conversationSource: "user",
        callSite: "mainAgent",
      }),
      expected: "user_interactive",
    },
    {
      name: "standard home-feed conversation maps to user_interactive",
      input: input({
        conversationType: "standard",
        conversationSource: "home-feed",
        callSite: "mainAgent",
      }),
      expected: "user_interactive",
    },
    {
      name: "standard imported conversation maps to user_interactive",
      input: input({
        conversationType: "standard",
        conversationSource: "import:chatgpt",
        callSite: "mainAgent",
      }),
      expected: "user_interactive",
    },
    // 7. User created background.
    {
      name: "background conversation the user created maps to user_created_background",
      input: input({
        conversationType: "background",
        conversationSource: "user",
        callSite: "mainAgent",
      }),
      expected: "user_created_background",
    },
    {
      name: "watcher source maps to user_created_background",
      input: input({
        conversationType: "background",
        conversationSource: "watcher",
        callSite: "mainAgent",
      }),
      expected: "user_created_background",
    },
    {
      name: "sequence source maps to user_created_background",
      input: input({
        conversationType: "background",
        conversationSource: "sequence",
        callSite: "mainAgent",
      }),
      expected: "user_created_background",
    },
    // 8. System-owned conversation sources.
    {
      name: "background notification conversation maps to other_system",
      input: input({
        conversationType: "background",
        conversationSource: "notification",
        callSite: "mainAgent",
      }),
      expected: "other_system",
    },
    {
      name: "standard notification thread the user replies in maps to user_interactive",
      input: input({
        conversationType: "standard",
        conversationSource: "notification",
        callSite: "mainAgent",
      }),
      expected: "user_interactive",
    },
    {
      name: "auto-analysis source maps to other_system",
      input: input({
        conversationType: "background",
        conversationSource: "auto-analysis",
        callSite: "mainAgent",
      }),
      expected: "other_system",
    },
    // 9. Recognized call site, no conversation.
    {
      name: "recognized call site with no conversation maps to other_system",
      input: input({ callSite: "conversationTitle" }),
      expected: "other_system",
    },
    {
      name: "auxiliary call site (commitMessage) with no conversation maps to other_system",
      input: input({ callSite: "commitMessage" }),
      expected: "other_system",
    },
    // 10. Nothing to attribute.
    {
      name: "no conversation and no call site maps to unknown",
      input: base,
      expected: "unknown",
    },
    {
      name: "unrecognized call site with no conversation maps to unknown",
      input: input({ callSite: "someRetiredCallSite" }),
      expected: "unknown",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(classifyWorkOrigin(c.input)).toBe(c.expected);
    });
  }
});

/**
 * Guard against a residual bucket. Every named bucket is an allowlist, so an
 * unrecognized type/source combination must land in `unknown`, where it stays
 * visible, and never in a bucket whose name asserts a cause nobody verified.
 */
describe("classifyWorkOrigin residual-bucket guard: unrecognized combinations stay unknown", () => {
  const residualCases: Array<{ name: string; input: WorkOriginInput }> = [
    {
      name: "background conversation with an arbitrary plugin source",
      input: input({
        conversationType: "background",
        conversationSource: "someplugin-custom-source",
        callSite: "mainAgent",
      }),
    },
    {
      name: "standard conversation with a non-user source",
      input: input({
        conversationType: "standard",
        conversationSource: "runtime-export",
        callSite: "mainAgent",
      }),
    },
    {
      name: "background conversation with a background-tool source",
      input: input({
        conversationType: "background",
        conversationSource: "background-tool",
        callSite: "mainAgent",
      }),
    },
    {
      name: "background conversation with no source",
      input: input({ conversationType: "background", callSite: "mainAgent" }),
    },
    {
      name: "standard conversation with no source",
      input: input({ conversationType: "standard", callSite: "mainAgent" }),
    },
    {
      name: "unrecognized conversation type with a user source",
      input: input({
        conversationType: "experimental",
        conversationSource: "user",
        callSite: "mainAgent",
      }),
    },
    {
      name: "import-prefixed source outside a standard conversation",
      input: input({
        conversationType: "background",
        conversationSource: "import:chatgpt",
        callSite: "mainAgent",
      }),
    },
    {
      name: "home-feed source outside a standard conversation",
      input: input({
        conversationType: "background",
        conversationSource: "home-feed",
        callSite: "mainAgent",
      }),
    },
    // Legacy and ambiguous sources: each denotes too little to name a cause.
    ...(["background", "compaction", "direct", "reminder", "task"] as const)
      .flatMap((conversationSource) =>
        (["standard", "background"] as const).map((conversationType) => ({
          conversationSource,
          conversationType,
        })),
      )
      .map(({ conversationSource, conversationType }) => ({
        name: `legacy source "${conversationSource}" in a ${conversationType} conversation`,
        input: input({
          conversationType,
          conversationSource,
          callSite: "mainAgent",
        }),
      })),
  ];

  for (const c of residualCases) {
    test(`${c.name} is unknown, not a named bucket`, () => {
      expect(classifyWorkOrigin(c.input)).toBe("unknown");
    });
  }
});
