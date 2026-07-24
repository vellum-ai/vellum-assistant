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
    // 1. Delegated child — parent linkage present, whatever else is set.
    {
      name: "subagent spawn (parent + background) → delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "subagent",
        callSite: "mainAgent",
        parentConversationId: "parent-1",
      }),
      expected: "delegated_child",
    },
    {
      name: "retrospective fork (parent resolved via fork parent, memory call site) → delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "memory-retrospective",
        callSite: "memoryRetrospective",
        parentConversationId: "source-1",
      }),
      expected: "delegated_child",
    },
    {
      name: "parent linkage wins over a scheduled type",
      input: input({
        conversationType: "scheduled",
        conversationSource: "schedule",
        parentConversationId: "parent-2",
      }),
      expected: "delegated_child",
    },
    // 1b. Delegated child recovered from the record-time source when the
    // spawning conversation was deleted before flush (parent linkage gone).
    {
      name: "GC'd retrospective fork (stamped source, no parent, memory call site) → delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "memory-retrospective-fork",
        callSite: "memoryRetrospective",
        parentConversationId: null,
      }),
      expected: "delegated_child",
    },
    {
      name: "GC'd legacy retrospective (stamped source, no parent) → delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "memory-retrospective",
        callSite: "memoryRetrospective",
        parentConversationId: null,
      }),
      expected: "delegated_child",
    },
    {
      name: "GC'd subagent conversation (stamped source, no parent) → delegated_child",
      input: input({
        conversationType: "background",
        conversationSource: "subagent",
        callSite: "mainAgent",
        parentConversationId: null,
      }),
      expected: "delegated_child",
    },
    {
      name: "stamped-spawn source wins over a scheduled type when parent is gone",
      input: input({
        conversationType: "scheduled",
        conversationSource: "subagent",
        parentConversationId: null,
      }),
      expected: "delegated_child",
    },
    // 2. Scheduled.
    {
      name: "scheduled conversation → user_created_schedule",
      input: input({
        conversationType: "scheduled",
        conversationSource: "schedule",
        callSite: "mainAgent",
      }),
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
      name: "manually-run schedule (schedule source, standard type) → user_created_schedule",
      input: input({
        conversationType: "standard",
        conversationSource: "schedule",
        callSite: "mainAgent",
      }),
      expected: "user_created_schedule",
    },
    // 3a. Heartbeat.
    {
      name: "heartbeat call site → heartbeat",
      input: input({
        conversationType: "background",
        conversationSource: "background-tool",
        callSite: "heartbeatAgent",
      }),
      expected: "heartbeat",
    },
    // 3b. Memory maintenance — every dedicated call site.
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
      ] as const
    ).map((callSite) => ({
      name: `${callSite} call site → memory_maintenance`,
      input: input({ callSite }),
      expected: "memory_maintenance" as WorkOrigin,
    })),
    {
      name: "recall inside a standard user conversation → memory_maintenance (call site wins over user_interactive)",
      input: input({
        conversationType: "standard",
        conversationSource: "user",
        callSite: "recall",
      }),
      expected: "memory_maintenance",
    },
    {
      name: "memory consolidation with no conversation → memory_maintenance",
      input: input({ callSite: "memoryConsolidation" }),
      expected: "memory_maintenance",
    },
    // 4. User-interactive.
    {
      name: "standard user conversation → user_interactive",
      input: input({
        conversationType: "standard",
        conversationSource: "user",
        callSite: "mainAgent",
      }),
      expected: "user_interactive",
    },
    // 5. Remaining conversation-scoped work.
    {
      name: "background conversation (no parent/memory) → user_created_background",
      input: input({
        conversationType: "background",
        conversationSource: "background-tool",
        callSite: "mainAgent",
      }),
      expected: "user_created_background",
    },
    {
      name: "standard conversation with a non-user source → user_created_background",
      input: input({
        conversationType: "standard",
        conversationSource: "runtime-export",
        callSite: "mainAgent",
      }),
      expected: "user_created_background",
    },
    // 6. Recognized call site, no conversation.
    {
      name: "recognized call site, no conversation → other_system",
      input: input({ callSite: "conversationTitle" }),
      expected: "other_system",
    },
    {
      name: "auxiliary call site (commitMessage), no conversation → other_system",
      input: input({ callSite: "commitMessage" }),
      expected: "other_system",
    },
    // 7. Nothing to attribute.
    {
      name: "no conversation and no call site → unknown",
      input: base,
      expected: "unknown",
    },
    {
      name: "unrecognized call site, no conversation → unknown",
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
