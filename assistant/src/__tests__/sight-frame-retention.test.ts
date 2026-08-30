import { beforeEach, describe, expect, test } from "bun:test";

import { applySightFrameRetention } from "../daemon/conversation-runtime-assembly.js";
import {
  addMessage,
  getMessages,
  selectSightFrameCaptureTimes,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema.js";
import type { ContentBlock, Message } from "../providers/types.js";

await initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: "test",
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    })
    .onConflictDoNothing()
    .run();
}

function frameContent(attachmentId: string): string {
  return JSON.stringify([
    { type: "text", text: "what am I looking at" },
    {
      type: "image",
      source: {
        type: "workspace_ref",
        media_type: "image/jpeg",
        attachmentId,
        sizeBytes: 1024,
      },
    },
  ]);
}

function referenceImage(
  attachmentId: string,
): Extract<ContentBlock, { type: "image" }> {
  return {
    type: "image",
    source: {
      type: "workspace_ref",
      media_type: "image/jpeg",
      attachmentId,
      sizeBytes: 1024,
    },
  };
}

describe("selectSightFrameCaptureTimes", () => {
  const conversationId = "conv-sight-frame-times";

  beforeEach(() => {
    ensureConversation(conversationId);
  });

  test("maps tagged attachment ids to the row that carried them", async () => {
    const first = await addMessage(
      conversationId,
      "user",
      frameContent("att-1"),
      { metadata: { sightFrameAttachmentIds: ["att-1"] } },
    );
    const second = await addMessage(
      conversationId,
      "user",
      frameContent("att-2"),
      { metadata: { sightFrameAttachmentIds: ["att-2", "att-3"] } },
    );

    const rows = getMessages(conversationId);
    const createdAtById = new Map(rows.map((r) => [r.id, r.createdAt]));
    const captureTimes = selectSightFrameCaptureTimes(conversationId);

    expect(captureTimes.get("att-1")).toBe(createdAtById.get(first.id)!);
    expect(captureTimes.get("att-2")).toBe(createdAtById.get(second.id)!);
    expect(captureTimes.get("att-3")).toBe(createdAtById.get(second.id)!);
  });

  test("is empty for a conversation whose rows carry no tag", async () => {
    const untaggedId = "conv-sight-frame-untagged";
    ensureConversation(untaggedId);
    await addMessage(untaggedId, "user", frameContent("att-9"), {
      metadata: { voiceSessionTurn: true },
    });
    await addMessage(untaggedId, "assistant", "sure");

    expect(selectSightFrameCaptureTimes(untaggedId).size).toBe(0);
  });

  test("drops a row that only mentions the key in an unrelated value", async () => {
    const mentionId = "conv-sight-frame-mention";
    ensureConversation(mentionId);
    await addMessage(mentionId, "user", "hello", {
      metadata: { backgroundEventSource: "sightFrameAttachmentIds" },
    });

    expect(selectSightFrameCaptureTimes(mentionId).size).toBe(0);
  });
});

describe("applySightFrameRetention", () => {
  test("stubs the aged frames of a tagged conversation", async () => {
    const conversationId = "conv-sight-frame-retention";
    ensureConversation(conversationId);
    for (const attachmentId of ["att-a", "att-b", "att-c"]) {
      await addMessage(conversationId, "user", frameContent(attachmentId), {
        metadata: { sightFrameAttachmentIds: [attachmentId] },
      });
    }

    const assembled: Message[] = [
      { role: "user", content: [referenceImage("att-a")] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [referenceImage("att-b")] },
      { role: "user", content: [referenceImage("att-c")] },
    ];

    const retained = applySightFrameRetention(assembled, conversationId);

    expect(retained[0].content[0].type).toBe("text");
    expect(retained[2].content[0]).toEqual(referenceImage("att-b"));
    expect(retained[3].content[0]).toEqual(referenceImage("att-c"));
  });

  test("returns the same array for a conversation with no tagged rows", async () => {
    const conversationId = "conv-sight-frame-retention-untagged";
    ensureConversation(conversationId);
    await addMessage(conversationId, "user", frameContent("att-z"));

    const assembled: Message[] = [
      { role: "user", content: [referenceImage("att-z")] },
    ];

    expect(applySightFrameRetention(assembled, conversationId)).toBe(assembled);
  });
});
