import { describe, expect, test } from "bun:test";

import { writeSlackMetadata } from "../../messaging/providers/slack/message-metadata.js";
import {
  buildReactionRowEnvelope,
  buildSlackReactionMeta,
} from "../../messaging/reaction-envelopes.js";
import { mergeProviderMessageMetadata } from "../../messaging/read-provider-metadata.js";
import type { ContentBlock } from "../../providers/types.js";
import {
  type ContactReader,
  MESSAGE_AUDIENCE_METADATA_KEY,
  projectRowForContact,
} from "../contact-visible-content.js";
import {
  NO_RESPONSE_MESSAGE_KIND,
  REACTION_MESSAGE_KIND,
} from "../conversation-types.js";
import { ASSISTANT_TEXT_VISIBILITY_KEY } from "../user-facing-content.js";

const ALICE: ContactReader = { principalId: "principal-alice" };
const BOB: ContactReader = { principalId: "principal-bob" };

const REFERENCE_SOURCE = {
  type: "workspace_ref",
  media_type: "image/png",
  attachmentId: "att-1",
  sizeBytes: 1024,
  filename: "photo.png",
  width: 10,
  height: 20,
} as const;

/**
 * One sample of every variant in the stored block union, keyed by type so a
 * new variant does not compile until it has a sample here.
 */
const SAMPLE_OF_EACH_TYPE: {
  [K in ContentBlock["type"]]: Extract<ContentBlock, { type: K }>;
} = {
  text: { type: "text", text: "Hello" },
  thinking: { type: "thinking", thinking: "private reasoning", signature: "s" },
  redacted_thinking: { type: "redacted_thinking", data: "opaque" },
  image: { type: "image", source: REFERENCE_SOURCE },
  file: {
    type: "file",
    source: { ...REFERENCE_SOURCE, media_type: "text/plain" },
  },
  tool_use: { type: "tool_use", id: "tu_1", name: "bash", input: {} },
  tool_result: { type: "tool_result", tool_use_id: "tu_1", content: "ls" },
  server_tool_use: {
    type: "server_tool_use",
    id: "st_1",
    name: "web_search",
    input: {},
  },
  web_search_tool_result: {
    type: "web_search_tool_result",
    tool_use_id: "st_1",
    content: [],
  },
  ui_surface: { type: "ui_surface", surfaceId: "s1", surfaceType: "card" },
};

describe("projectRowForContact", () => {
  test("allows only text and attachment references", () => {
    const projected = projectRowForContact(
      {
        role: "assistant",
        content: Object.values(SAMPLE_OF_EACH_TYPE),
        metadata: null,
      },
      ALICE,
    );
    expect(projected.map((b) => b.type)).toEqual(["text", "image", "file"]);
  });

  test("drops reasoning on a row with no private marker", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "let me consider", signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Here is the answer." },
    ];
    expect(
      projectRowForContact({ role: "assistant", content, metadata: {} }, ALICE),
    ).toEqual([{ type: "text", text: "Here is the answer." }]);
  });

  test("drops an unknown block type", () => {
    const content = [
      { type: "text", text: "visible" },
      { type: "future_block", text: "hidden", payload: { secret: true } },
    ] as unknown as ContentBlock[];
    expect(
      projectRowForContact(
        { role: "assistant", content, metadata: null },
        ALICE,
      ),
    ).toEqual([{ type: "text", text: "visible" }]);
  });

  test("drops tool calls and their results", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "tu_1", name: "file_read", input: {} },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "file contents",
        contentBlocks: [{ type: "text", text: "nested" }],
      },
    ];
    expect(
      projectRowForContact(
        { role: "assistant", content, metadata: null },
        ALICE,
      ),
    ).toEqual([]);
  });

  test("on a private row, shows delivered messages and not the scratchpad", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "reasoning", signature: "sig" },
      { type: "text", text: "working notes" },
      {
        type: "tool_use",
        id: "tu_1",
        name: "send_user_message",
        input: { message: "All done." },
      },
    ];
    const metadata = JSON.stringify({
      [ASSISTANT_TEXT_VISIBILITY_KEY]: "private",
    });
    expect(
      projectRowForContact({ role: "assistant", content, metadata }, ALICE),
    ).toEqual([{ type: "text", text: "All done." }]);
  });

  test("drops the text fallback of a UI card", () => {
    const content = [
      { type: "ui_surface", surfaceId: "s1", surfaceType: "approval" },
      { type: "text", text: "Approve?", _surfaceFallback: true },
    ] as ContentBlock[];
    expect(
      projectRowForContact(
        { role: "assistant", content, metadata: null },
        ALICE,
      ),
    ).toEqual([]);
  });

  test("keeps the redaction rider and nothing else on text", () => {
    const content = [
      { type: "text", text: "hi", _redactionVersion: 1, _internal: "x" },
    ] as unknown as ContentBlock[];
    expect(
      projectRowForContact(
        { role: "assistant", content, metadata: null },
        ALICE,
      ),
    ).toEqual([{ type: "text", text: "hi", _redactionVersion: 1 }]);
  });

  test("projects an attachment to its reference only", () => {
    const content = [
      {
        type: "file",
        source: { ...REFERENCE_SOURCE, extra: "dropped" },
        extracted_text: "file body",
        _attachmentId: "att-1",
      },
    ] as unknown as ContentBlock[];
    expect(
      projectRowForContact(
        { role: "assistant", content, metadata: null },
        ALICE,
      ),
    ).toEqual([{ type: "file", source: REFERENCE_SOURCE }]);
  });

  test("drops inline media bytes", () => {
    const content: ContentBlock[] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
        _attachmentId: "att-1",
      },
    ];
    expect(
      projectRowForContact(
        { role: "assistant", content, metadata: null },
        ALICE,
      ),
    ).toEqual([]);
  });

  describe("audience", () => {
    const content: ContentBlock[] = [{ type: "text", text: "Only for you." }];
    const restrictedTo = (userId: string) => ({
      [MESSAGE_AUDIENCE_METADATA_KEY]: { kind: "oneReader", userId },
    });

    test("drops a restricted reply for a non-addressee", () => {
      expect(
        projectRowForContact(
          {
            role: "assistant",
            content,
            metadata: restrictedTo(ALICE.principalId),
          },
          BOB,
        ),
      ).toEqual([]);
    });

    test("shows a restricted reply to its addressee", () => {
      expect(
        projectRowForContact(
          {
            role: "assistant",
            content,
            metadata: JSON.stringify(restrictedTo(ALICE.principalId)),
          },
          ALICE,
        ),
      ).toEqual([{ type: "text", text: "Only for you." }]);
    });

    test("drops a row whose audience does not parse", () => {
      expect(
        projectRowForContact(
          {
            role: "assistant",
            content,
            metadata: { [MESSAGE_AUDIENCE_METADATA_KEY]: { kind: "everyone" } },
          },
          ALICE,
        ),
      ).toEqual([]);
    });
  });

  test("drops internal scaffolding rows", () => {
    const content: ContentBlock[] = [{ type: "text", text: "tool output" }];
    for (const metadata of [
      { hidden: true },
      { backgroundEventSource: "background-tool" },
      { subagentNotification: { subagentId: "s", label: "l" } },
    ]) {
      expect(
        projectRowForContact({ role: "user", content, metadata }, ALICE),
      ).toEqual([]);
    }
  });

  describe("inline silence sentinel", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "Sure, done. <no_response/>" },
      { type: "text", text: "<no_response/>" },
    ];

    test("is stripped from assistant text, dropping emptied blocks", () => {
      expect(
        projectRowForContact(
          { role: "assistant", content, metadata: null },
          ALICE,
        ),
      ).toEqual([{ type: "text", text: "Sure, done." }]);
    });

    test("is left alone in user text", () => {
      expect(
        projectRowForContact({ role: "user", content, metadata: null }, ALICE),
      ).toEqual([
        { type: "text", text: "Sure, done. <no_response/>" },
        { type: "text", text: "<no_response/>" },
      ]);
    });
  });

  describe("untrusted fence", () => {
    const fenced =
      '<external_content source="webhook">\nHello from Alice\n</external_content>';
    const row = {
      role: "user",
      content: [{ type: "text", text: fenced }] as ContentBlock[],
      metadata: null,
    };

    test("is unwrapped for display", () => {
      expect(projectRowForContact(row, ALICE)).toEqual([
        { type: "text", text: "Hello from Alice" },
      ]);
    });

    test("is kept when asked", () => {
      expect(
        projectRowForContact(row, ALICE, { keepUntrustedFence: true }),
      ).toEqual([{ type: "text", text: fenced }]);
    });
  });

  test("drops a deliberate silence", () => {
    const content: ContentBlock[] = [{ type: "text", text: "<no_response/>" }];
    const metadata = JSON.stringify({ messageKind: NO_RESPONSE_MESSAGE_KIND });
    expect(
      projectRowForContact({ role: "assistant", content, metadata }, ALICE),
    ).toEqual([]);
  });

  describe("reaction", () => {
    const content: ContentBlock[] = [{ type: "text", text: "[reaction]" }];
    const facts = {
      channel: "telegram",
      chatId: "chat-1",
      targetMessageId: "msg-1",
      emoji: "thumbsup",
      op: "added",
    } as const;

    test("drops the assistant's own reaction", () => {
      const metadata = {
        messageKind: REACTION_MESSAGE_KIND,
        ...buildReactionRowEnvelope(facts),
      };
      expect(
        projectRowForContact({ role: "assistant", content, metadata }, ALICE),
      ).toEqual([]);
    });

    test("drops an inbound reaction", () => {
      const metadata = JSON.stringify(
        buildReactionRowEnvelope({ ...facts, actorDisplayName: "Bob" }),
      );
      expect(
        projectRowForContact({ role: "user", content, metadata }, ALICE),
      ).toEqual([]);
    });

    test("drops a legacy flat Slack reaction", () => {
      const metadata = writeSlackMetadata(
        buildSlackReactionMeta({ ...facts, channel: "slack" }),
      );
      expect(
        projectRowForContact({ role: "user", content, metadata }, ALICE),
      ).toEqual([]);
    });
  });

  describe("provider message state", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "Original text" },
      { type: "image", source: REFERENCE_SOURCE },
    ];
    const seed = {
      source: "telegram",
      conversationExternalId: "chat-1",
      messageId: "msg-1",
    } as const;

    test("drops a message deleted on its channel", () => {
      const metadata = JSON.stringify({
        providerMeta: mergeProviderMessageMetadata(null, seed, {
          deletedAt: 1,
        }),
      });
      for (const role of ["user", "assistant"]) {
        expect(
          projectRowForContact({ role, content, metadata }, ALICE),
        ).toEqual([]);
      }
    });

    test("drops a Slack message deleted on its channel", () => {
      const metadata = {
        slackMeta: writeSlackMetadata({
          source: "slack",
          channelId: "C1",
          channelTs: "1.0",
          eventKind: "message",
          deletedAt: 1,
        }),
      };
      expect(
        projectRowForContact({ role: "user", content, metadata }, ALICE),
      ).toEqual([]);
    });

    test("shows the current text of an edited message", () => {
      const metadata = JSON.stringify({
        providerMeta: mergeProviderMessageMetadata(null, seed, {
          editedAt: 1,
        }),
      });
      expect(
        projectRowForContact({ role: "user", content, metadata }, ALICE),
      ).toEqual([
        { type: "text", text: "Original text" },
        { type: "image", source: REFERENCE_SOURCE },
      ]);
    });
  });

  test("drops rows whose role is not user or assistant", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "Context for the model" },
      { type: "image", source: REFERENCE_SOURCE },
    ];
    for (const role of ["system", "tool", ""]) {
      expect(
        projectRowForContact({ role, content, metadata: null }, ALICE),
      ).toEqual([]);
    }
  });

  test("drops a row whose metadata cannot be read", () => {
    const content: ContentBlock[] = [{ type: "text", text: "Hello" }];
    expect(
      projectRowForContact(
        { role: "assistant", content, metadata: "{not json" },
        ALICE,
      ),
    ).toEqual([]);
  });
});
