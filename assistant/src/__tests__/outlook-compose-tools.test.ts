import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OAuthConnection } from "../oauth/connection.js";
import type { ToolContext } from "../tools/types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

const createDraftMock = mock(
  async (_conn: OAuthConnection, _draft: Record<string, unknown>) => ({
    id: "draft-new-1",
    subject: "Test",
    body: { contentType: "text", content: "hello" },
    toRecipients: [],
    ccRecipients: [],
  }),
);

const createReplyDraftMock = mock(
  async (_conn: OAuthConnection, _msgId: string, _comment?: string) => ({
    id: "draft-reply-1",
    subject: "Re: Test",
    body: { contentType: "text", content: "reply" },
    toRecipients: [{ emailAddress: { address: "original@example.com" } }],
    ccRecipients: [],
  }),
);

const patchMessageMock = mock(
  async (
    _conn: OAuthConnection,
    _msgId: string,
    _fields: Record<string, unknown>,
  ) => ({
    id: "draft-reply-1",
  }),
);

const sendDraftMock = mock(
  async (_conn: OAuthConnection, _msgId: string) => {},
);

const createForwardDraftMock = mock(
  async (
    _conn: OAuthConnection,
    _msgId: string,
    _to?: unknown[],
    _comment?: string,
  ) => ({
    id: "draft-fwd-1",
    subject: "Fwd: Test",
    body: { contentType: "text", content: "forwarded" },
    toRecipients: [],
    ccRecipients: [],
  }),
);

const fakeConnection = {
  id: "conn-1",
  provider: "microsoft",
  accountInfo: "user@outlook.com",
} as unknown as OAuthConnection;

mock.module("../messaging/providers/outlook/client.js", () => ({
  createDraft: createDraftMock,
  createReplyDraft: createReplyDraftMock,
  patchMessage: patchMessageMock,
  sendDraft: sendDraftMock,
  createForwardDraft: createForwardDraftMock,
}));

mock.module("../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async () => fakeConnection,
}));

// Import tools after mocks are set up
import { run as runDraft } from "../config/bundled-skills/outlook/tools/outlook-draft.js";
import { run as runForward } from "../config/bundled-skills/outlook/tools/outlook-forward.js";
import { run as runSendDraft } from "../config/bundled-skills/outlook/tools/outlook-send-draft.js";

const baseContext: ToolContext = {
  workingDir: "/tmp",
  conversationId: "conv-1",
  trustClass: "guardian" as const,
};

// ── outlook_draft ────────────────────────────────────────────────────────────

describe("outlook_draft", () => {
  beforeEach(() => {
    createDraftMock.mockClear();
    createReplyDraftMock.mockClear();
    patchMessageMock.mockClear();
  });

  test("creates a new draft with to, subject, body", async () => {
    const result = await runDraft(
      { to: "alice@example.com", subject: "Hello", body: "Hi there" },
      baseContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Draft created (ID: draft-new-1)");
    expect(createDraftMock).toHaveBeenCalledTimes(1);
    const [conn, draft] = createDraftMock.mock.calls[0];
    expect(conn).toBe(fakeConnection);
    expect(draft).toMatchObject({
      subject: "Hello",
      body: { contentType: "text", content: "Hi there" },
    });
  });

  test("creates a new draft with cc and bcc", async () => {
    const result = await runDraft(
      {
        to: "alice@example.com",
        subject: "Hello",
        body: "Hi",
        cc: "bob@example.com",
        bcc: "charlie@example.com",
      },
      baseContext,
    );

    expect(result.isError).toBe(false);
    const [, draft] = createDraftMock.mock.calls[0];
    expect(draft.ccRecipients).toEqual([
      { emailAddress: { address: "bob@example.com" } },
    ]);
    expect(draft.bccRecipients).toEqual([
      { emailAddress: { address: "charlie@example.com" } },
    ]);
  });

  test("creates a reply draft when in_reply_to is provided", async () => {
    const result = await runDraft(
      {
        to: "alice@example.com",
        subject: "Re: Hello",
        body: "Thanks!",
        in_reply_to: "msg-original-1",
      },
      baseContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Draft created (ID: draft-reply-1)");
    expect(createReplyDraftMock).toHaveBeenCalledTimes(1);
    const [, msgId, comment] = createReplyDraftMock.mock.calls[0];
    expect(msgId).toBe("msg-original-1");
    expect(comment).toBe("Thanks!");
    // Should patch recipients since to is specified
    expect(patchMessageMock).toHaveBeenCalledTimes(1);
    const [, patchMsgId] = patchMessageMock.mock.calls[0];
    expect(patchMsgId).toBe("draft-reply-1");
  });

  test("patches reply draft with custom cc and bcc", async () => {
    const result = await runDraft(
      {
        to: "alice@example.com",
        subject: "Re: Hello",
        body: "Thanks!",
        in_reply_to: "msg-original-1",
        cc: "bob@example.com",
        bcc: "secret@example.com",
      },
      baseContext,
    );

    expect(result.isError).toBe(false);
    expect(patchMessageMock).toHaveBeenCalledTimes(1);
    const [, , patchFields] = patchMessageMock.mock.calls[0];
    expect(patchFields.toRecipients).toEqual([
      { emailAddress: { address: "alice@example.com" } },
    ]);
    expect(patchFields.ccRecipients).toEqual([
      { emailAddress: { address: "bob@example.com" } },
    ]);
    expect(patchFields.bccRecipients).toEqual([
      { emailAddress: { address: "secret@example.com" } },
    ]);
  });

  test("returns error when to is missing", async () => {
    const result = await runDraft(
      { subject: "Hello", body: "Hi" },
      baseContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("to is required");
  });

  test("returns error when subject is missing", async () => {
    const result = await runDraft(
      { to: "alice@example.com", body: "Hi" },
      baseContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("subject is required");
  });

  test("returns error when body is missing", async () => {
    const result = await runDraft(
      { to: "alice@example.com", subject: "Hello" },
      baseContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("body is required");
  });
});

// ── outlook_send_draft ───────────────────────────────────────────────────────

describe("outlook_send_draft", () => {
  beforeEach(() => {
    sendDraftMock.mockClear();
  });

  test("sends a draft when triggered by surface action", async () => {
    const result = await runSendDraft(
      { draft_id: "draft-1", confidence: 0.9 },
      { ...baseContext, triggeredBySurfaceAction: true },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("Draft sent.");
    expect(sendDraftMock).toHaveBeenCalledTimes(1);
    const [, draftId] = sendDraftMock.mock.calls[0];
    expect(draftId).toBe("draft-1");
  });

  test("rejects when not triggered by surface action", async () => {
    const result = await runSendDraft(
      { draft_id: "draft-1", confidence: 0.9 },
      baseContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("surface action");
    expect(sendDraftMock).not.toHaveBeenCalled();
  });

  test("returns error when draft_id is missing", async () => {
    const result = await runSendDraft(
      { confidence: 0.9 },
      { ...baseContext, triggeredBySurfaceAction: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("draft_id is required");
  });
});

// ── outlook_forward ──────────────────────────────────────────────────────────

describe("outlook_forward", () => {
  beforeEach(() => {
    createForwardDraftMock.mockClear();
  });

  test("creates a forward draft", async () => {
    const result = await runForward(
      { message_id: "msg-1", to: "bob@example.com", confidence: 0.9 },
      baseContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Forward draft created (ID: draft-fwd-1)");
    expect(createForwardDraftMock).toHaveBeenCalledTimes(1);
    const [, msgId, toList] = createForwardDraftMock.mock.calls[0];
    expect(msgId).toBe("msg-1");
    expect(toList).toEqual([{ emailAddress: { address: "bob@example.com" } }]);
  });

  test("creates a forward draft with comment", async () => {
    const result = await runForward(
      {
        message_id: "msg-1",
        to: "bob@example.com",
        comment: "FYI",
        confidence: 0.9,
      },
      baseContext,
    );

    expect(result.isError).toBe(false);
    const [, , , fwdComment] = createForwardDraftMock.mock.calls[0];
    expect(fwdComment).toBe("FYI");
  });

  test("creates a forward draft with multiple recipients", async () => {
    const result = await runForward(
      {
        message_id: "msg-1",
        to: "bob@example.com, carol@example.com",
        confidence: 0.9,
      },
      baseContext,
    );

    expect(result.isError).toBe(false);
    const [, , toList] = createForwardDraftMock.mock.calls[0];
    expect(toList).toEqual([
      { emailAddress: { address: "bob@example.com" } },
      { emailAddress: { address: "carol@example.com" } },
    ]);
  });

  test("returns error when message_id is missing", async () => {
    const result = await runForward(
      { to: "bob@example.com", confidence: 0.9 },
      baseContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("message_id is required");
  });

  test("returns error when to is missing", async () => {
    const result = await runForward(
      { message_id: "msg-1", confidence: 0.9 },
      baseContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("to is required");
  });
});
