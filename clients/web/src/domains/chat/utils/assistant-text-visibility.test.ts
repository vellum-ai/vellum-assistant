import { describe, expect, test } from "bun:test";

import { readAssistantTextVisibility } from "@/domains/chat/utils/assistant-text-visibility";

describe("readAssistantTextVisibility", () => {
  test("reads the two known markers", () => {
    expect(
      readAssistantTextVisibility({ assistantTextVisibility: "private" }),
    ).toBe("private");
    expect(
      readAssistantTextVisibility({ assistantTextVisibility: "visible" }),
    ).toBe("visible");
  });

  test("answers undefined for anything else", () => {
    // An unmarked row, a daemon that predates the marker, a value this client
    // does not recognize, and a malformed payload all degrade to the shipped
    // rendering rather than hiding or restyling a reply.
    expect(readAssistantTextVisibility({})).toBeUndefined();
    expect(
      readAssistantTextVisibility({ assistantTextVisibility: "later" }),
    ).toBeUndefined();
    expect(
      readAssistantTextVisibility({ assistantTextVisibility: true }),
    ).toBeUndefined();
    expect(readAssistantTextVisibility(undefined)).toBeUndefined();
    expect(readAssistantTextVisibility(null)).toBeUndefined();
    expect(readAssistantTextVisibility("private")).toBeUndefined();
  });
});
