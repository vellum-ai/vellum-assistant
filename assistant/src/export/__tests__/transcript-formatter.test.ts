import { describe, expect, mock, test } from "bun:test";

import { z } from "zod";

type TestMessage = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
  clientMessageId: string | null;
};

const parentMessages: TestMessage[] = [
  {
    id: "msg-parent-1",
    conversationId: "parent-conv",
    role: "user",
    content: JSON.stringify([{ type: "text", text: "go research foo" }]),
    createdAt: 1_700_000_000_000,
    metadata: null,
    clientMessageId: null,
  },
  {
    id: "msg-parent-2",
    conversationId: "parent-conv",
    role: "assistant",
    content: JSON.stringify([{ type: "text", text: "spawning subagent" }]),
    createdAt: 1_700_000_001_000,
    metadata: JSON.stringify({
      subagentNotification: {
        subagentId: "sa-1",
        label: "research-foo",
        status: "completed",
        conversationId: "child-conv-1",
      },
    }),
    clientMessageId: null,
  },
];

const childMessages: TestMessage[] = [
  {
    id: "msg-child-1",
    conversationId: "child-conv-1",
    role: "user",
    content: JSON.stringify([
      { type: "text", text: "Objective: research foo and report back." },
    ]),
    createdAt: 1_700_000_002_000,
    metadata: null,
    clientMessageId: null,
  },
  {
    id: "msg-child-2",
    conversationId: "child-conv-1",
    role: "assistant",
    content: JSON.stringify([
      { type: "text", text: "I found that foo is a bar." },
    ]),
    createdAt: 1_700_000_003_000,
    metadata: null,
    clientMessageId: null,
  },
];

const messageMetadataSchema = z.object({
  subagentNotification: z
    .object({
      subagentId: z.string(),
      label: z.string(),
      status: z.enum(["running", "completed", "failed", "aborted"]),
      conversationId: z.string().optional(),
    })
    .optional(),
});

mock.module("../../persistence/conversation-crud.js", () => ({
  getConversation: (_id: string) => null,
  getMessages: (id: string) =>
    id === "child-conv-1" ? childMessages : parentMessages,
  messageMetadataSchema,
  parseMessageMetadata: (json: string | null) => {
    if (!json) {
      return undefined;
    }
    try {
      const parsed = messageMetadataSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  },
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../../util/truncate.js", () => ({
  truncate: (s: string) => s,
}));

mock.module("../../daemon/date-context.js", () => ({
  formatLocalTimestamp: (_ts: number, _tz?: string) => "TIME",
}));

const { formatMessageSliceForTranscript } =
  await import("../transcript-formatter.js");

describe("formatMessageSliceForTranscript subagent labels", () => {
  test("embedded subagent transcripts render with generic role labels even when parent display names are provided", () => {
    const out = formatMessageSliceForTranscript(parentMessages, {
      assistantName: "Bob",
      userName: "Alice",
    });

    // Parent messages use the provided display names.
    expect(out).toContain("## Alice (TIME)");
    expect(out).toContain("## Bob (TIME)");

    // Subagent block headers must use generic labels — the child "user" message
    // is actually the parent assistant's objective, so labeling it "Alice"
    // would misattribute the assistant's tasking text to the human user.
    expect(out).toContain("### Subagent: research-foo (completed)");
    expect(out).toContain("> **User** (TIME)");
    expect(out).toContain("> **Assistant** (TIME)");
    expect(out).not.toContain("> **Alice**");
    expect(out).not.toContain("> **Bob**");
  });

  test("without display-name options, parent and subagent both use generic labels", () => {
    const out = formatMessageSliceForTranscript(parentMessages);

    expect(out).toContain("## User (TIME)");
    expect(out).toContain("## Assistant (TIME)");
    expect(out).toContain("> **User** (TIME)");
    expect(out).toContain("> **Assistant** (TIME)");
  });
});
