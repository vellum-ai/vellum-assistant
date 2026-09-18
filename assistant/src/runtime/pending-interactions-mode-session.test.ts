import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import * as pendingInteractions from "./pending-interactions.js";

describe("pending interaction mode-session waits", () => {
  const invalidateStructuralWait = mock(() => true);

  beforeEach(() => {
    pendingInteractions.clear();
    clearConversations();
    invalidateStructuralWait.mockClear();
    setConversation("conv-1", {
      modeSessions: { invalidateStructuralWait },
    } as unknown as Conversation);
  });

  afterEach(() => {
    pendingInteractions.clear();
    clearConversations();
  });

  test.each([
    ["question", "question"],
    ["confirmation", "confirmation"],
    ["acp_confirmation", "confirmation"],
    ["secret", "secret"],
  ] as const)(
    "resolving %s invalidates its exact structural wait",
    (interactionKind, structuralKind) => {
      pendingInteractions.register("request-1", {
        conversationId: "conv-1",
        kind: interactionKind,
      });

      expect(pendingInteractions.resolve("request-1", "answered")).toEqual(
        expect.objectContaining({ kind: interactionKind }),
      );
      expect(invalidateStructuralWait).toHaveBeenCalledTimes(1);
      expect(invalidateStructuralWait).toHaveBeenCalledWith({
        kind: structuralKind,
        responseId: "request-1",
      });
    },
  );

  test("does not invalidate for a missing or non-structural interaction", () => {
    expect(pendingInteractions.resolve("missing", "answered")).toBeUndefined();
    pendingInteractions.register("host-request", {
      conversationId: "conv-1",
      kind: "host_cu",
    });

    pendingInteractions.resolve("host-request", "answered");

    expect(invalidateStructuralWait).not.toHaveBeenCalled();
  });
});
