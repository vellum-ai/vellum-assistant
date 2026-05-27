import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { pickConversationIdWireField } from "@/lib/backwards-compat/conversation-id-wire-field";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts` (covers null/empty, unparseable, pre-release, `v`
// prefix, etc). Here we verify the wire-field branch on each side
// of the 0.8.6 boundary plus the conservative-on-unknown policy.
describe("pickConversationIdWireField", () => {
  test("returns conversationKey when version is unknown", () => {
    setVersion(null);
    expect(pickConversationIdWireField()).toBe("conversationKey");
  });

  test("returns conversationKey for assistants on 0.8.5 and older", () => {
    setVersion("0.8.5");
    expect(pickConversationIdWireField()).toBe("conversationKey");
    setVersion("0.8.4");
    expect(pickConversationIdWireField()).toBe("conversationKey");
    setVersion("0.7.0");
    expect(pickConversationIdWireField()).toBe("conversationKey");
  });

  test("returns conversationId for assistants on 0.8.6+", () => {
    setVersion("0.8.6");
    expect(pickConversationIdWireField()).toBe("conversationId");
    setVersion("0.9.0");
    expect(pickConversationIdWireField()).toBe("conversationId");
    setVersion("1.0.0");
    expect(pickConversationIdWireField()).toBe("conversationId");
  });

  test("treats RC builds of the cutover patch as supporting the new field", () => {
    // 0.8.6-rc.1 ships with the same handlers as 0.8.6, so RC
    // testers must get the new wire field.
    setVersion("0.8.6-rc.1");
    expect(pickConversationIdWireField()).toBe("conversationId");
    setVersion("0.8.6-beta");
    expect(pickConversationIdWireField()).toBe("conversationId");
  });

  test("returns conversationKey for unparseable versions", () => {
    setVersion("garbage");
    expect(pickConversationIdWireField()).toBe("conversationKey");
    setVersion("0.8");
    expect(pickConversationIdWireField()).toBe("conversationKey");
  });
});
