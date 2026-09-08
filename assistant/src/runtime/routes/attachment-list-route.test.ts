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

const PNG_BASE64 = "iVBORw0K";

async function newAttachment(filename: string): Promise<string> {
  const uploaded = await uploadAttachment(filename, "image/png", PNG_BASE64);
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
 * turn beside an ordinary photo, plus a hidden row and an unfinalized row that
 * must not surface at all.
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

  test("omits hidden and unfinalized rows", async () => {
    const seeded = await seedConversation();

    const filenames = listAttachments({
      conversationId: seeded.conversationId,
    }).attachments.map((a) => a.filename);

    expect(filenames).not.toContain("hidden.png");
    expect(filenames).not.toContain("streaming.png");
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

  test("rejects an unknown sightFrames value", async () => {
    const seeded = await seedConversation();

    expect(() =>
      listAttachments({
        conversationId: seeded.conversationId,
        sightFrames: "maybe",
      }),
    ).toThrow(BadRequestError);
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
