import { describe, expect, it } from "bun:test";

import {
  OVERLAY_PROCESS_KINDS,
  POPOUT_OVERLAY_PROCESS_KINDS,
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
  it("excludes subagents and ACP runs", () => {
    // The header's ConversationActivityPill carries them. Adding either here
    // gives one process two entry points and puts a floating banner back on top
    // of incoming messages (LUM-2800).
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

describe("POPOUT_OVERLAY_PROCESS_KINDS", () => {
  it("covers every kind", () => {
    // A pop-out renders no header, so the overlay is its only ambient surface.
    // Dropping a kind here makes that work invisible in a pop-out entirely.
    expect(POPOUT_OVERLAY_PROCESS_KINDS.map((d) => d.kind).sort()).toEqual(
      PROCESS_KINDS.map((d) => d.kind).sort(),
    );
  });

  it("covers the kinds the windowed overlay leaves to the header", () => {
    const popout = POPOUT_OVERLAY_PROCESS_KINDS.map((d) => d.kind);
    expect(popout).toContain("subagent");
    expect(popout).toContain("acp-run");
  });
});
