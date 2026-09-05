import { describe, expect, test } from "bun:test";

import {
  isSendUserMessageCall,
  readAssistantTextVisibility,
} from "@/domains/chat/utils/assistant-text-visibility";

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
    // An unmarked row, a value this client does not recognize, and a malformed
    // payload all read as no marker, which is the standard rendering rather
    // than a hidden or restyled reply.
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

describe("isSendUserMessageCall", () => {
  test("matches the reply tool only", () => {
    expect(isSendUserMessageCall({ name: "send_user_message" })).toBe(true);
    expect(isSendUserMessageCall({ name: "bash" })).toBe(false);
  });
});
