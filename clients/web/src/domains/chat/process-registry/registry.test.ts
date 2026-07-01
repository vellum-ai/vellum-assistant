import { describe, expect, it } from "bun:test";

import { PROCESS_KINDS } from "@/domains/chat/process-registry/registry";

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
