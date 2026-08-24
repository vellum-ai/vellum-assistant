import { beforeEach, describe, expect, it } from "bun:test";

import {
  getCompanionConversationId,
  resolveCompanionDraftConversationId,
  setCompanionConversationId,
} from "@/utils/companion-conversation";

beforeEach(() => {
  setCompanionConversationId(null);
});

describe("companion-conversation", () => {
  it("has no conversation before the composer sends anything", () => {
    expect(getCompanionConversationId()).toBeNull();
  });

  it("remembers the conversation the composer started", () => {
    setCompanionConversationId("draft-1");
    expect(getCompanionConversationId()).toBe("draft-1");
  });

  // The bug this module exists for: the first message goes to a draft id the
  // send then re-keys, and a memory left on the draft sends every follow-up to
  // a conversation that no longer exists, minting a new one each time.
  it("follows the composer's draft to the id the server assigned", () => {
    setCompanionConversationId("draft-1");
    resolveCompanionDraftConversationId("draft-1", "server-1");
    expect(getCompanionConversationId()).toBe("server-1");
  });

  it("ignores a draft resolution from some other conversation", () => {
    setCompanionConversationId("draft-1");
    resolveCompanionDraftConversationId("draft-2", "server-2");
    expect(getCompanionConversationId()).toBe("draft-1");
  });

  it("ignores a resolution while the composer has sent nothing", () => {
    resolveCompanionDraftConversationId("draft-1", "server-1");
    expect(getCompanionConversationId()).toBeNull();
  });

  it("takes the new thread when the composer starts one", () => {
    setCompanionConversationId("draft-1");
    resolveCompanionDraftConversationId("draft-1", "server-1");
    setCompanionConversationId("draft-2");
    expect(getCompanionConversationId()).toBe("draft-2");
  });
});
