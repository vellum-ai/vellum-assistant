import { beforeEach, describe, expect, test } from "bun:test";

import { applySightFrameRetention } from "../daemon/conversation-runtime-assembly.js";
import {
  getAttachmentMetadataForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
  forkConversation,
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

  test("reaches live inline frames that never reloaded from the DB", async () => {
    const conversationId = "conv-sight-frame-retention-live";
    ensureConversation(conversationId);
    for (const attachmentId of ["live-a", "live-b", "live-c"]) {
      await addMessage(conversationId, "user", frameContent(attachmentId), {
        metadata: { sightFrameAttachmentIds: [attachmentId] },
      });
    }

    // What `persistQueuedMessageBody` pushes into `ctx.messages`: inline bytes
    // carrying the id of the row persisted as a reference.
    const liveImage = (
      attachmentId: string,
    ): Extract<ContentBlock, { type: "image" }> => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAAAAAAA" },
      _attachmentId: attachmentId,
    });
    const assembled: Message[] = [
      { role: "user", content: [liveImage("live-a")] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [liveImage("live-b")] },
      { role: "user", content: [liveImage("live-c")] },
    ];

    const retained = applySightFrameRetention(assembled, conversationId);

    expect(retained[0].content[0].type).toBe("text");
    expect(retained[2].content[0]).toEqual(liveImage("live-b"));
    expect(retained[3].content[0]).toEqual(liveImage("live-c"));
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

describe("forked conversations", () => {
  test("a fork's tag covers both its source and cloned attachment ids", async () => {
    // A fork copies `messages.content` verbatim, so its blocks still name the
    // SOURCE attachment ids, while `message_attachments` is re-linked to
    // freshly CLONED rows. The compactor reads the link side and stamps cloned
    // ids onto the frames it rebuilds, so a tag naming only one vocabulary
    // goes blind on the other.
    const db = getDb();
    db.run("DELETE FROM message_attachments");
    db.run("DELETE FROM attachments");

    const source = createConversation("camera call");
    const uploaded = await uploadAttachment(
      "frame.png",
      "image/png",
      "iVBORw0K",
    );
    const row = await addMessage(
      source.id,
      "user",
      JSON.stringify([
        {
          type: "image",
          source: {
            type: "workspace_ref",
            media_type: "image/png",
            attachmentId: uploaded.id,
            sizeBytes: 8,
          },
        },
      ]),
      {
        metadata: { sightFrameAttachmentIds: [uploaded.id] },
        skipIndexing: true,
      },
    );
    linkAttachmentToMessage(row.id, uploaded.id, 0);

    const fork = forkConversation({ conversationId: source.id });
    const forkRow = getMessages(fork.id)[0];
    const clonedId = getAttachmentMetadataForMessage(forkRow.id)[0]?.id;

    // The fork really did clone the attachment under a new id.
    expect(clonedId).toBeDefined();
    expect(clonedId).not.toBe(uploaded.id);

    const captureTimes = selectSightFrameCaptureTimes(fork.id);
    // Both vocabularies resolve, so a frame is matchable whether it arrived
    // through the copied content or through the compactor's manifest.
    expect(captureTimes.has(uploaded.id)).toBe(true);
    expect(captureTimes.has(clonedId!)).toBe(true);

    // The source conversation is untouched by the widening.
    expect([...selectSightFrameCaptureTimes(source.id).keys()]).toEqual([
      uploaded.id,
    ]);
  });

  test("retention still matches the frames a fork holds directly", async () => {
    const db = getDb();
    db.run("DELETE FROM message_attachments");
    db.run("DELETE FROM attachments");

    const source = createConversation("camera call 2");
    const ids: string[] = [];
    for (const name of ["a.png", "b.png", "c.png"]) {
      const uploaded = await uploadAttachment(name, "image/png", "iVBORw0K");
      const row = await addMessage(
        source.id,
        "user",
        JSON.stringify([
          {
            type: "image",
            source: {
              type: "workspace_ref",
              media_type: "image/png",
              attachmentId: uploaded.id,
              sizeBytes: 8,
            },
          },
        ]),
        {
          metadata: { sightFrameAttachmentIds: [uploaded.id] },
          skipIndexing: true,
        },
      );
      linkAttachmentToMessage(row.id, uploaded.id, 0);
      ids.push(uploaded.id);
    }

    const fork = forkConversation({ conversationId: source.id });
    // The fork's own rows, exactly as its history assembles them.
    const assembled: Message[] = getMessages(fork.id).map((r) => ({
      role: "user" as const,
      content: r.content,
    }));

    const retained = applySightFrameRetention(assembled, fork.id);

    // Oldest of the three is stubbed; the newest two survive.
    expect(retained[0].content[0].type).toBe("text");
    expect(retained[1].content[0].type).toBe("image");
    expect(retained[2].content[0].type).toBe("image");
  });
});
