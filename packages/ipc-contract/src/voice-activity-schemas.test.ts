/**
 * The voice activity payload's boundary: main parses every `update` with
 * `voiceActivityContentSchema`, so what it keeps of a payload is what the
 * companion's call bar draws.
 */
import { describe, expect, test } from "bun:test";

import { voiceActivityContentSchema } from "./schemas";

const CONTENT = {
  phase: "thinking",
  label: "Working on that…",
  accentHex: "#5eead4",
  muted: false,
  outputMuted: false,
  detail: "Searching the web",
  approvalRequestId: "",
};

const WORK = {
  id: "sub-1",
  kind: "subagent",
  title: "Flights to Lisbon",
  step: "Reading a page",
  state: "running",
  startedAt: 1_000,
} as const;

describe("voiceActivityContentSchema", () => {
  test("takes a payload from a sender that predates the work list", () => {
    const parsed = voiceActivityContentSchema.parse(CONTENT);
    expect(parsed.work).toBeUndefined();
  });

  test("keeps the work list", () => {
    const parsed = voiceActivityContentSchema.parse({
      ...CONTENT,
      work: [WORK],
    });
    expect(parsed.work).toEqual([WORK]);
  });

  test("refuses a piece of work in a state it does not know", () => {
    expect(
      voiceActivityContentSchema.safeParse({
        ...CONTENT,
        work: [{ ...WORK, state: "paused" }],
      }).success,
    ).toBe(false);
  });
});
