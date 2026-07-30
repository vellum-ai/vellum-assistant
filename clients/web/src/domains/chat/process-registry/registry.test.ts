import { describe, expect, it } from "bun:test";

import {
  OVERLAY_PROCESS_KINDS,
  PROCESS_KINDS,
} from "@/domains/chat/process-registry/registry";

describe("PROCESS_KINDS registry", () => {
  it("contains all four background-process descriptors", () => {
    expect(PROCESS_KINDS).toHaveLength(4);
  });

  it("encodes the overlay left-to-right order", () => {
    expect(PROCESS_KINDS.map((descriptor) => descriptor.kind)).toEqual([
      "subagent",
      "acp-run",
      "workflow",
      "background-task",
    ]);
  });

  it("has a unique kind per descriptor", () => {
    const kinds = PROCESS_KINDS.map((descriptor) => descriptor.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe("OVERLAY_PROCESS_KINDS", () => {
  it("no longer floats subagents or ACP runs over the transcript", () => {
    // Their doorway is the header's ConversationActivityPill. Re-adding either
    // here would give one process two entry points and put the banner back on
    // top of incoming messages (LUM-2800).
    const kinds = OVERLAY_PROCESS_KINDS.map((descriptor) => descriptor.kind);
    expect(kinds).not.toContain("subagent");
    expect(kinds).not.toContain("acp-run");
  });

  it("keeps the kinds Activity does not cover", () => {
    expect(OVERLAY_PROCESS_KINDS.map((d) => d.kind)).toEqual([
      "workflow",
      "background-task",
    ]);
  });

  it("only contains descriptors that are in the full registry", () => {
    for (const descriptor of OVERLAY_PROCESS_KINDS) {
      expect(PROCESS_KINDS).toContain(descriptor);
    }
  });
});
