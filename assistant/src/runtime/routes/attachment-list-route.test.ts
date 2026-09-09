/**
 * Guards over `GET /v1/attachments?conversationId=`: the conversation
 * attachment listing that the Chat Info panel reads.
 *
 * Runs against a real database so the lineage predicate, the finalized
 * filter, and the camera-frame flags are exercised on stored rows rather than
 * on a stub's idea of them.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  linkAttachmentToMessage,
  setAttachmentThumbnail,
  uploadAttachment,
} from "../../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
  forkConversationForRetrospective,
} from "../../persistence/conversation-crud.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { messages } from "../../persistence/schema/index.js";
import { BadRequestError } from "./errors.js";

await initializeDb();

const { ROUTES } = await import("./attachment-routes.js");

interface ListedAttachment {
  id: string;
  filename: string;
  messageId: string;
  createdAt: number;
  sightFrame: boolean;
  ambientKeep: boolean;
  thumbnailData?: string;
}

interface ListResult {
  attachments: ListedAttachment[];
  total: number;
  hasMore: boolean;
}

function listAttachments(queryParams: Record<string, string>): ListResult {
  const route = ROUTES.find((r) => r.operationId === "attachment_list");
  if (!route) {
    throw new Error("attachment_list route not registered");
  }
  return route.handler({ queryParams }) as ListResult;
}

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function setCreatedAt(messageId: string, createdAt: number): void {
  getDb()
    .update(messages)
    .set({ createdAt })
    .where(eq(messages.id, messageId))
    .run();
}

function setFinalized(messageId: string, finalized: number): void {
  getDb()
    .update(messages)
    .set({ finalized })
    .where(eq(messages.id, messageId))
    .run();
}

function setRole(messageId: string, role: string): void {
  getDb()
    .update(messages)
    .set({ role })
    .where(eq(messages.id, messageId))
    .run();
}

const PNG_BASE64 = "iVBORw0K";

async function newAttachment(filename: string): Promise<string> {
  const uploaded = await uploadAttachment(filename, "image/png", PNG_BASE64);
  return uploaded.id;
}

async function newVideoAttachment(
  filename: string,
  thumbnail: string,
): Promise<string> {
  const uploaded = await uploadAttachment(filename, "video/mp4", PNG_BASE64);
  setAttachmentThumbnail(uploaded.id, thumbnail);
  return uploaded.id;
}

interface Seeded {
  conversationId: string;
  photoA: string;
  photoB: string;
  photoC: string;
  ambientFrame: string;
  parkedFrame: string;
}

/**
 * A conversation carrying one attachment of every kind the listing has to tell
 * apart: plain photos, a standalone camera keep, a frame parked on a spoken
 * turn beside an ordinary photo, plus a hidden row, a channel-deleted row, and
 * an unfinalized row that must not surface at all.
 */
async function seedConversation(): Promise<Seeded> {
  const conversation = createConversation("Camera thread");

  const photoA = await newAttachment("a.png");
  const first = await addMessage(conversation.id, "user", "first photo", {
    skipIndexing: true,
  });
  linkAttachmentToMessage(first.id, photoA, 0);
  setCreatedAt(first.id, 1000);

  const photoB = await newAttachment("b.png");
  const second = await addMessage(conversation.id, "user", "second photo", {
    skipIndexing: true,
  });
  linkAttachmentToMessage(second.id, photoB, 0);
  setCreatedAt(second.id, 2000);

  const ambientFrame = await newAttachment("ambient.png");
  const keep = await addMessage(conversation.id, "user", "", {
    metadata: { scripted: true, sightFrameAttachmentIds: [ambientFrame] },
    skipIndexing: true,
  });
  linkAttachmentToMessage(keep.id, ambientFrame, 0);
  setCreatedAt(keep.id, 3000);

  const photoC = await newAttachment("c.png");
  const parkedFrame = await newAttachment("parked.png");
  const spoken = await addMessage(conversation.id, "user", "look at this", {
    metadata: { sightFrameAttachmentIds: [parkedFrame] },
    skipIndexing: true,
  });
  linkAttachmentToMessage(spoken.id, photoC, 0);
  linkAttachmentToMessage(spoken.id, parkedFrame, 1);
  setCreatedAt(spoken.id, 4000);

  const hiddenPhoto = await newAttachment("hidden.png");
  const hidden = await addMessage(conversation.id, "user", "scaffolding", {
    metadata: { hidden: true },
    skipIndexing: true,
  });
  linkAttachmentToMessage(hidden.id, hiddenPhoto, 0);
  setCreatedAt(hidden.id, 5000);

  const deletedPhoto = await newAttachment("deleted.png");
  const channelDeleted = await addMessage(
    conversation.id,
    "user",
    "sent then deleted",
    {
      metadata: {
        providerMeta: JSON.stringify({
          source: "slack",
          conversationExternalId: "chan-1",
          messageId: "msg-1",
          eventKind: "message",
          deletedAt: 1700000001000,
        }),
      },
      skipIndexing: true,
    },
  );
  linkAttachmentToMessage(channelDeleted.id, deletedPhoto, 0);
  setCreatedAt(channelDeleted.id, 5500);

  const streamingPhoto = await newAttachment("streaming.png");
  const streaming = await addMessage(conversation.id, "user", "mid write", {
    skipIndexing: true,
  });
  linkAttachmentToMessage(streaming.id, streamingPhoto, 0);
  setCreatedAt(streaming.id, 6000);
  setFinalized(streaming.id, 0);

  return {
    conversationId: conversation.id,
    photoA,
    photoB,
    photoC,
    ambientFrame,
    parkedFrame,
  };
}

describe("GET /v1/attachments", () => {
  beforeEach(() => {
    resetTables();
  });

  test("lists a conversation's attachments newest first, metadata only", async () => {
    const seeded = await seedConversation();

    const result = listAttachments({ conversationId: seeded.conversationId });

    expect(result.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.parkedFrame,
      seeded.ambientFrame,
      seeded.photoB,
      seeded.photoA,
    ]);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(false);
    for (const attachment of result.attachments) {
      expect(attachment).not.toHaveProperty("data");
    }
  });

  test("flags the standalone keep as an ambient keep and the parked frame as neither", async () => {
    const seeded = await seedConversation();

    const byId = new Map(
      listAttachments({
        conversationId: seeded.conversationId,
      }).attachments.map((a) => [a.id, a]),
    );

    expect(byId.get(seeded.ambientFrame)).toMatchObject({
      sightFrame: true,
      ambientKeep: true,
    });
    expect(byId.get(seeded.parkedFrame)).toMatchObject({
      sightFrame: true,
      ambientKeep: false,
    });
    expect(byId.get(seeded.photoC)).toMatchObject({
      sightFrame: false,
      ambientKeep: false,
    });
  });

  test("omits hidden, channel-deleted, and unfinalized rows", async () => {
    const seeded = await seedConversation();

    const listing = listAttachments({
      conversationId: seeded.conversationId,
    });
    const filenames = listing.attachments.map((a) => a.filename);

    expect(filenames).not.toContain("hidden.png");
    expect(filenames).not.toContain("deleted.png");
    expect(filenames).not.toContain("streaming.png");
    expect(listing.total).toBe(5);
  });

  test("omits attachments carried only by a tool or system row", async () => {
    const conversation = createConversation("Machine rows");

    const systemPhoto = await newAttachment("system.png");
    const systemRow = await addMessage(conversation.id, "system", "boot", {
      skipIndexing: true,
    });
    linkAttachmentToMessage(systemRow.id, systemPhoto, 0);
    setCreatedAt(systemRow.id, 1000);

    const toolPhoto = await newAttachment("tool.png");
    const toolRow = await addMessage(conversation.id, "user", "tool output", {
      skipIndexing: true,
    });
    linkAttachmentToMessage(toolRow.id, toolPhoto, 0);
    setCreatedAt(toolRow.id, 2000);
    setRole(toolRow.id, "tool");

    const spokenPhoto = await newAttachment("spoken.png");
    const spoken = await addMessage(conversation.id, "user", "mine", {
      skipIndexing: true,
    });
    linkAttachmentToMessage(spoken.id, spokenPhoto, 0);
    setCreatedAt(spoken.id, 3000);

    const result = listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([spokenPhoto]);
    expect(result.total).toBe(1);
  });

  test("lists an attachment carried twice once, under the newest carrier", async () => {
    const conversation = createConversation("Resent");

    const photo = await newAttachment("shared.png");
    const older = await addMessage(conversation.id, "user", "first send", {
      skipIndexing: true,
    });
    linkAttachmentToMessage(older.id, photo, 0);
    setCreatedAt(older.id, 1000);

    const newer = await addMessage(conversation.id, "user", "second send", {
      skipIndexing: true,
    });
    linkAttachmentToMessage(newer.id, photo, 0);
    setCreatedAt(newer.id, 2000);

    const result = listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([photo]);
    expect(result.total).toBe(1);
    expect(result.attachments[0]?.messageId).toBe(newer.id);
    expect(result.attachments[0]?.createdAt).toBe(2000);
  });

  test("falls back to an older visible carrier when the newest one is skipped", async () => {
    const conversation = createConversation("Requoted");

    const hiddenCarried = await newAttachment("requoted.png");
    const visibleFirst = await addMessage(conversation.id, "user", "shared", {
      skipIndexing: true,
    });
    linkAttachmentToMessage(visibleFirst.id, hiddenCarried, 0);
    setCreatedAt(visibleFirst.id, 1000);

    const hiddenLater = await addMessage(
      conversation.id,
      "user",
      "scaffolding",
      { metadata: { hidden: true }, skipIndexing: true },
    );
    linkAttachmentToMessage(hiddenLater.id, hiddenCarried, 0);
    setCreatedAt(hiddenLater.id, 2000);

    const deletedCarried = await newAttachment("resent.png");
    const visibleSecond = await addMessage(
      conversation.id,
      "user",
      "also shared",
      { skipIndexing: true },
    );
    linkAttachmentToMessage(visibleSecond.id, deletedCarried, 0);
    setCreatedAt(visibleSecond.id, 3000);

    const deletedLater = await addMessage(
      conversation.id,
      "user",
      "sent then deleted",
      {
        metadata: {
          providerMeta: JSON.stringify({
            source: "slack",
            conversationExternalId: "chan-1",
            messageId: "msg-2",
            eventKind: "message",
            deletedAt: 1700000001000,
          }),
        },
        skipIndexing: true,
      },
    );
    linkAttachmentToMessage(deletedLater.id, deletedCarried, 0);
    setCreatedAt(deletedLater.id, 4000);

    const result = listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([
      deletedCarried,
      hiddenCarried,
    ]);
    expect(result.attachments.map((a) => a.messageId)).toEqual([
      visibleSecond.id,
      visibleFirst.id,
    ]);
    expect(result.total).toBe(2);
  });

  test("splits the set on sightFrames, and total follows the filter", async () => {
    const seeded = await seedConversation();

    const only = listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "only",
    });
    expect(only.attachments.map((a) => a.id)).toEqual([
      seeded.parkedFrame,
      seeded.ambientFrame,
    ]);
    expect(only.total).toBe(2);

    const excluded = listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "exclude",
    });
    expect(excluded.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.photoB,
      seeded.photoA,
    ]);
    expect(excluded.total).toBe(3);
  });

  test("hasMore under a sightFrames filter counts the filtered set", async () => {
    const seeded = await seedConversation();

    const firstFrame = listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "only",
      limit: "1",
    });
    expect(firstFrame.attachments.map((a) => a.id)).toEqual([
      seeded.parkedFrame,
    ]);
    expect(firstFrame.total).toBe(2);
    expect(firstFrame.hasMore).toBe(true);

    const lastFrame = listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "only",
      limit: "1",
      offset: "1",
    });
    expect(lastFrame.attachments.map((a) => a.id)).toEqual([
      seeded.ambientFrame,
    ]);
    expect(lastFrame.hasMore).toBe(false);
  });

  test("pages with limit and offset", async () => {
    const seeded = await seedConversation();

    const page = listAttachments({
      conversationId: seeded.conversationId,
      limit: "1",
      offset: "1",
    });

    expect(page.attachments.map((a) => a.id)).toEqual([seeded.parkedFrame]);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(true);

    const last = listAttachments({
      conversationId: seeded.conversationId,
      limit: "1",
      offset: "4",
    });
    expect(last.attachments.map((a) => a.id)).toEqual([seeded.photoA]);
    expect(last.hasMore).toBe(false);
  });

  test("rejects a request without a conversation", () => {
    expect(() => listAttachments({})).toThrow(BadRequestError);
  });

  test("rejects a non-numeric limit", async () => {
    const seeded = await seedConversation();

    expect(() =>
      listAttachments({ conversationId: seeded.conversationId, limit: "abc" }),
    ).toThrow(BadRequestError);
  });

  test("rejects a non-numeric offset", async () => {
    const seeded = await seedConversation();

    expect(() =>
      listAttachments({ conversationId: seeded.conversationId, offset: "abc" }),
    ).toThrow(BadRequestError);
  });

  test("rejects a fractional limit or offset", async () => {
    const seeded = await seedConversation();

    expect(() =>
      listAttachments({ conversationId: seeded.conversationId, limit: "1.9" }),
    ).toThrow(BadRequestError);
    expect(() =>
      listAttachments({ conversationId: seeded.conversationId, offset: "2.5" }),
    ).toThrow(BadRequestError);
  });

  test("clamps an out-of-range limit or offset rather than rejecting it", async () => {
    const seeded = await seedConversation();

    const zeroLimit = listAttachments({
      conversationId: seeded.conversationId,
      limit: "0",
    });
    expect(zeroLimit.attachments.map((a) => a.id)).toEqual([seeded.photoC]);
    expect(zeroLimit.total).toBe(5);
    expect(zeroLimit.hasMore).toBe(true);

    const overMaxLimit = listAttachments({
      conversationId: seeded.conversationId,
      limit: "5000",
    });
    expect(overMaxLimit.attachments).toHaveLength(5);
    expect(overMaxLimit.hasMore).toBe(false);

    const negativeOffset = listAttachments({
      conversationId: seeded.conversationId,
      offset: "-1",
    });
    expect(negativeOffset.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.parkedFrame,
      seeded.ambientFrame,
      seeded.photoB,
      seeded.photoA,
    ]);
    expect(negativeOffset.hasMore).toBe(false);
  });

  test("hydrates the thumbnail for the returned page only", async () => {
    const conversation = createConversation("Clips");

    const olderClip = await newVideoAttachment("older.mp4", "OLDER_THUMB");
    const older = await addMessage(conversation.id, "user", "older clip", {
      skipIndexing: true,
    });
    linkAttachmentToMessage(older.id, olderClip, 0);
    setCreatedAt(older.id, 1000);

    const newerClip = await newVideoAttachment("newer.mp4", "NEWER_THUMB");
    const newer = await addMessage(conversation.id, "user", "newer clip", {
      skipIndexing: true,
    });
    linkAttachmentToMessage(newer.id, newerClip, 0);
    setCreatedAt(newer.id, 2000);

    const first = listAttachments({
      conversationId: conversation.id,
      limit: "1",
    });
    expect(first.attachments.map((a) => a.id)).toEqual([newerClip]);
    expect(first.attachments[0]?.thumbnailData).toBe("NEWER_THUMB");
    expect(first.attachments.map((a) => a.thumbnailData)).not.toContain(
      "OLDER_THUMB",
    );

    const second = listAttachments({
      conversationId: conversation.id,
      limit: "1",
      offset: "1",
    });
    expect(second.attachments.map((a) => a.id)).toEqual([olderClip]);
    expect(second.attachments[0]?.thumbnailData).toBe("OLDER_THUMB");
  });

  test("rejects an unknown sightFrames value", async () => {
    const seeded = await seedConversation();

    expect(() =>
      listAttachments({
        conversationId: seeded.conversationId,
        sightFrames: "maybe",
      }),
    ).toThrow(BadRequestError);
  });

  test("treats an empty sightFrames value as no filter", async () => {
    const seeded = await seedConversation();

    const result = listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "",
    });

    expect(result.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.parkedFrame,
      seeded.ambientFrame,
      seeded.photoB,
      seeded.photoA,
    ]);
    expect(result.total).toBe(5);
  });

  test("a referential fork lists the attachments it inherited", async () => {
    const seeded = await seedConversation();

    const fork = await forkConversationForRetrospective({
      conversationId: seeded.conversationId,
    });

    const result = listAttachments({ conversationId: fork.id });

    expect(result.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.parkedFrame,
      seeded.ambientFrame,
      seeded.photoB,
      seeded.photoA,
    ]);
  });
});
