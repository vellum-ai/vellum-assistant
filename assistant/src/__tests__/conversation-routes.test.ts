import { describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

import type { RuntimeMessageSessionOptions } from "../runtime/http-types.js";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-legacy-test" }),
  getConversationByKey: () => null,
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
}));

mock.module("../runtime/trust-context-resolver.js", () => ({
  resolveTrustContext: (input: { sourceChannel?: string }) => ({
    trustClass: "guardian",
    sourceChannel: input.sourceChannel ?? "vellum",
  }),
  withSourceChannel: (sourceChannel: string, ctx: Record<string, unknown>) => ({
    ...ctx,
    sourceChannel,
  }),
}));

import type { AuthContext } from "../runtime/auth/types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";

/** Synthetic AuthContext for tests — mimics a local actor with full scopes. */
const mockAuthContext: AuthContext = {
  subject: "actor:self:test-principal",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "test-principal",
  scopeProfile: "actor_client_v1",
  scopes: new Set([
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
  ]),
  policyEpoch: 1,
};

describe("handleSendMessage", () => {
  test("legacy fallback passes guardian context to processor", async () => {
    let capturedOptions: RuntimeMessageSessionOptions | undefined;
    let capturedSourceChannel: string | undefined;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationKey: "legacy-fallback-key",
        content: "Hello from legacy fallback",
        sourceChannel: "telegram",
        interface: "telegram",
      }),
    });

    const res = await handleSendMessage(
      req,
      {
        processMessage: async (
          _conversationId,
          _content,
          _attachmentIds,
          options,
          sourceChannel,
        ) => {
          capturedOptions = options;
          capturedSourceChannel = sourceChannel;
          return { messageId: "msg-legacy-fallback" };
        },
      },
      mockAuthContext,
    );

    const body = (await res.json()) as { accepted: boolean; messageId: string };
    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBe("msg-legacy-fallback");
    expect(capturedSourceChannel).toBe("telegram");
    expect(capturedOptions?.trustContext).toEqual(
      expect.objectContaining({
        trustClass: "guardian",
        sourceChannel: "telegram",
      }),
    );
  });
});
