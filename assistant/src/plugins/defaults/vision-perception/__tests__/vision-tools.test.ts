import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ImageContent, Message } from "../../../../providers/types.js";
import type { ToolContext } from "../../../../tools/types.js";

// `mock.module` is process-global, so all stubbing for the vision tools lives in
// this one file. We stub the provider resolution (spreading the real module so
// `extractAllText` keeps working) and the attachment store (fixture bytes + a
// configurable row).

let sendMessageArgs: { messages: Message[]; options: unknown } | null = null;
let responseText = "A red bicycle leans against a brick wall.";

const fakeProvider = {
  name: "mock-vision-provider",
  async sendMessage(messages: Message[], options: unknown) {
    sendMessageArgs = { messages, options };
    return {
      content: [{ type: "text", text: responseText }],
      model: "mock-vision-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  },
};

const realPsm = await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realPsm,
  getConfiguredProvider: async () => fakeProvider,
}));

// The execution guard checks the visionPerception call site resolves to an
// enabled vision-capable provider. Drive it per test (defaults available).
let visionProviderAvailable = true;
mock.module("../src/vision-capability.js", () => ({
  isVisionPerceptionProviderAvailable: () => visionProviderAvailable,
  VISION_CALL_SITE: "visionPerception",
}));

// A 1x1 PNG — small enough that `optimizeImageForTransport` returns it
// unchanged, so the bytes flow through to the image block verbatim.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

interface FakeRow {
  id: string;
  originalFilename: string;
  mimeType: string;
  kind: string;
}

// The store stub is configurable per-test: `attachmentRows` maps id -> row,
// `attachmentBytes` maps id -> bytes, and `attachmentConversations` maps id ->
// the conversation it is linked to (the access-control scope the resolver
// enforces). A missing id resolves to null (mirroring the real store's
// not-found behavior).
let attachmentRows: Record<string, FakeRow> = {};
let attachmentBytes: Record<string, Buffer> = {};
let attachmentConversations: Record<string, string> = {};

mock.module("../../../../memory/attachments-store.js", () => ({
  getAttachmentById: (id: string) => attachmentRows[id] ?? null,
  getAttachmentContent: (id: string) => attachmentBytes[id] ?? null,
  getFilePathForAttachment: () => null,
  isAttachmentInConversation: (id: string, conversationId: string) =>
    attachmentConversations[id] === conversationId,
}));

const vlmAskTool = (await import("../tools/vlm-ask.js")).default;
const vlmDescribeTool = (await import("../tools/vlm-describe.js")).default;

const ctx = { conversationId: "c1" } as unknown as ToolContext;

beforeEach(() => {
  sendMessageArgs = null;
  responseText = "A red bicycle leans against a brick wall.";
  visionProviderAvailable = true;
  attachmentRows = {
    "att-1": {
      id: "att-1",
      originalFilename: "photo.png",
      mimeType: "image/png",
      kind: "image",
    },
    "att-doc": {
      id: "att-doc",
      originalFilename: "notes.pdf",
      mimeType: "application/pdf",
      kind: "document",
    },
  };
  attachmentBytes = { "att-1": PNG_BYTES, "att-doc": PNG_BYTES };
  // Both fixtures are linked to the current conversation ("c1") by default, so
  // the access-control check passes; per-test overrides exercise the rejection.
  attachmentConversations = { "att-1": "c1", "att-doc": "c1" };
});

describe("vlm_ask tool", () => {
  test("round-trips an attachment id through the vision model to text", async () => {
    const result = await vlmAskTool.execute?.(
      { media_ref: "att-1", question: "What is in this image?" },
      ctx,
    );

    expect(result?.isError).toBe(false);
    expect(result?.content).toBe(responseText);
  });

  test("sends a single user message containing an ImageContent block", async () => {
    await vlmAskTool.execute?.(
      { media_ref: "att-1", question: "What is in this image?" },
      ctx,
    );

    const sent = sendMessageArgs?.messages;
    expect(sent).toHaveLength(1);
    expect(sent?.[0].role).toBe("user");

    const blocks = sent?.[0].content ?? [];
    const image = blocks.find((b): b is ImageContent => b.type === "image");
    expect(image).toBeDefined();
    expect(image?.source.type).toBe("base64");
    expect(image?.source.data).toBe(PNG_BYTES.toString("base64"));

    const text = blocks.find((b) => b.type === "text");
    expect(text).toEqual({ type: "text", text: "What is in this image?" });
  });

  test("threads a region into the prompt on the 0-1000 scale", async () => {
    await vlmAskTool.execute?.(
      {
        media_ref: "att-1",
        question: "What does the sign say?",
        region: [100, 200, 300, 400],
      },
      ctx,
    );

    const sent = sendMessageArgs?.messages;
    const text = sent?.[0].content.find((b) => b.type === "text");
    expect(text?.type).toBe("text");
    const promptText = text?.type === "text" ? text.text : "";
    expect(promptText).toContain("What does the sign say?");
    expect(promptText).toContain("[x0,y0,x1,y1]=[100, 200, 300, 400]");
    expect(promptText).toContain("0–1000 normalized scale");
  });

  test("omits the region clause when no region is provided", async () => {
    await vlmAskTool.execute?.(
      { media_ref: "att-1", question: "What is in this image?" },
      ctx,
    );

    const sent = sendMessageArgs?.messages;
    const text = sent?.[0].content.find((b) => b.type === "text");
    expect(text).toEqual({ type: "text", text: "What is in this image?" });
  });

  test("returns isError (no throw) for a missing media_ref", async () => {
    const result = await vlmAskTool.execute?.(
      { media_ref: "does-not-exist", question: "?" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("No attachment found");
    expect(sendMessageArgs).toBeNull();
  });

  test("returns isError (no throw) for a non-image attachment", async () => {
    const result = await vlmAskTool.execute?.(
      { media_ref: "att-doc", question: "?" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("not an image");
    expect(sendMessageArgs).toBeNull();
  });

  test("BYOK guard: returns isError and sends nothing when no vision-capable provider resolves", async () => {
    // The visionPerception call site does not resolve to an enabled
    // vision-capable model (BYOK with the managed vision profile disabled), so
    // the execution guard refuses before any image bytes are sent.
    visionProviderAvailable = false;
    const result = await vlmAskTool.execute?.(
      { media_ref: "att-1", question: "What is in this image?" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("vision perception is unavailable");
    expect(sendMessageArgs).toBeNull();
  });
});

describe("vlm_describe tool", () => {
  test("returns the model's description as a non-error result", async () => {
    const result = await vlmDescribeTool.execute?.({ media_ref: "att-1" }, ctx);

    expect(result?.isError).toBe(false);
    expect(result?.content).toBe(responseText);

    const sent = sendMessageArgs?.messages;
    const image = sent?.[0].content.find((b) => b.type === "image");
    expect(image).toBeDefined();
  });

  test("returns isError (no throw) for a non-image attachment", async () => {
    const result = await vlmDescribeTool.execute?.(
      { media_ref: "att-doc" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("not an image");
  });
});

describe("conversation isolation (cross-conversation media_ref)", () => {
  test("resolves an attachment linked to the current conversation", async () => {
    // att-1 belongs to "c1", which is ctx.conversationId — the read proceeds.
    const result = await vlmAskTool.execute?.(
      { media_ref: "att-1", question: "What is in this image?" },
      ctx,
    );

    expect(result?.isError).toBe(false);
    expect(sendMessageArgs).not.toBeNull();
  });

  test("rejects an attachment id linked to a DIFFERENT conversation, reading no bytes", async () => {
    // The attachment row + bytes exist, but the link points at another
    // conversation ("other-conv"). A model that supplies this crafted id must
    // get an error and NO bytes may be read or sent.
    attachmentConversations = { "att-1": "other-conv" };

    const result = await vlmAskTool.execute?.(
      { media_ref: "att-1", question: "What is in this image?" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("No attachment found");
    // Fail closed: the cross-conversation bytes never reach the vision model.
    expect(sendMessageArgs).toBeNull();
  });

  test("rejects an unlinked attachment id across all image tools", async () => {
    attachmentConversations = {};
    for (const tool of [vlmAskTool, vlmDescribeTool]) {
      sendMessageArgs = null;
      const result = await tool.execute?.(
        { media_ref: "att-1", question: "?" },
        ctx,
      );
      expect(result?.isError).toBe(true);
      expect(sendMessageArgs).toBeNull();
    }
  });
});
