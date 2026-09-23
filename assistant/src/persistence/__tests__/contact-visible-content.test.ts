import { describe, expect, test } from "bun:test";

import { buildReactionRowEnvelope } from "../../messaging/reaction-envelopes.js";
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
      { content: Object.values(SAMPLE_OF_EACH_TYPE), metadata: null },
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
    expect(projectRowForContact({ content, metadata: {} }, ALICE)).toEqual([
      { type: "text", text: "Here is the answer." },
    ]);
  });

  test("drops an unknown block type", () => {
    const content = [
      { type: "text", text: "visible" },
      { type: "future_block", text: "hidden", payload: { secret: true } },
    ] as unknown as ContentBlock[];
    expect(projectRowForContact({ content, metadata: null }, ALICE)).toEqual([
      { type: "text", text: "visible" },
    ]);
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
    expect(projectRowForContact({ content, metadata: null }, ALICE)).toEqual(
      [],
    );
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
    expect(projectRowForContact({ content, metadata }, ALICE)).toEqual([
      { type: "text", text: "All done." },
    ]);
  });

  test("drops the text fallback of a UI card", () => {
    const content = [
      { type: "ui_surface", surfaceId: "s1", surfaceType: "approval" },
      { type: "text", text: "Approve?", _surfaceFallback: true },
    ] as ContentBlock[];
    expect(projectRowForContact({ content, metadata: null }, ALICE)).toEqual(
      [],
    );
  });

  test("keeps the redaction rider and nothing else on text", () => {
    const content = [
      { type: "text", text: "hi", _redactionVersion: 1, _internal: "x" },
    ] as unknown as ContentBlock[];
    expect(projectRowForContact({ content, metadata: null }, ALICE)).toEqual([
      { type: "text", text: "hi", _redactionVersion: 1 },
    ]);
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
    expect(projectRowForContact({ content, metadata: null }, ALICE)).toEqual([
      { type: "file", source: REFERENCE_SOURCE },
    ]);
  });

  test("drops inline media bytes", () => {
    const content: ContentBlock[] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
        _attachmentId: "att-1",
      },
    ];
    expect(projectRowForContact({ content, metadata: null }, ALICE)).toEqual(
      [],
    );
  });

  describe("audience", () => {
    const content: ContentBlock[] = [{ type: "text", text: "Only for you." }];
    const restrictedTo = (userId: string) => ({
      [MESSAGE_AUDIENCE_METADATA_KEY]: { kind: "oneReader", userId },
    });

    test("drops a restricted reply for a non-addressee", () => {
      expect(
        projectRowForContact(
          { content, metadata: restrictedTo(ALICE.principalId) },
          BOB,
        ),
      ).toEqual([]);
    });

    test("shows a restricted reply to its addressee", () => {
      expect(
        projectRowForContact(
          {
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
      expect(projectRowForContact({ content, metadata }, ALICE)).toEqual([]);
    }
  });

  test("drops a deliberate silence", () => {
    const content: ContentBlock[] = [{ type: "text", text: "<no_response/>" }];
    const metadata = JSON.stringify({ messageKind: NO_RESPONSE_MESSAGE_KIND });
    expect(projectRowForContact({ content, metadata }, ALICE)).toEqual([]);
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
      expect(projectRowForContact({ content, metadata }, ALICE)).toEqual([]);
    });

    test("drops an inbound reaction", () => {
      const metadata = JSON.stringify(
        buildReactionRowEnvelope({ ...facts, actorDisplayName: "Bob" }),
      );
      expect(projectRowForContact({ content, metadata }, ALICE)).toEqual([]);
    });
  });

  test("drops a row whose metadata cannot be read", () => {
    const content: ContentBlock[] = [{ type: "text", text: "Hello" }];
    expect(
      projectRowForContact({ content, metadata: "{not json" }, ALICE),
    ).toEqual([]);
  });
});
