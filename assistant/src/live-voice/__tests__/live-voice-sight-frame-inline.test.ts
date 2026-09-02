/**
 * Camera frames whose store write fails recoverably.
 *
 * Such a frame keeps its bytes inline in `messages.content` instead of
 * referencing an attachment row, which makes it the heaviest thing the
 * conversation resends on every later request. It is therefore the frame
 * retention most needs to be able to stub, and it is attributable only by the
 * id its block carries rather than by a link that was never written.
 *
 * Kept apart from `live-voice-photo.test.ts` because forcing the failure means
 * replacing an attachment-store export for the whole file, and the sibling
 * suite's clone case depends on that same export behaving for real.
 */

import { describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  createMockProvider,
  textResponse,
} from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";

setConfig("memory", { enabled: false });

// Scoping an attachment into the conversation is the step that fails
// recoverably, and a null return is how the persist path learns it did. Only
// the ids a test names are refused; everything else runs for real.
import * as attachmentsStoreNamespace from "../../persistence/attachments-store.js";

// Snapshotted BEFORE the mock is installed. The namespace binding is live, so
// it points at the replacement once `mock.module` runs, and delegating through
// it would call this wrapper again forever.
const realStore = { ...attachmentsStoreNamespace };

const unstorableAttachmentIds = new Set<string>();

// Armed for exactly one link, which is how the persist path's repair branch is
// reached without breaking the linking a test's own setup depends on.
let failNextLink = false;

// Armed for exactly one attachment resolve, which fails the persist before it
// reaches the message insert.
let failNextResolve = false;

// Ids conversation scoping handed back, so a test can name the clone it made.
// A clone is deleted by the failure path, so it cannot be read back after.
const scopedAttachmentIds: string[] = [];

// Armed for exactly one attachment byte read, which is how a throw is reached
// while the reference block is being built: after the row was cloned and
// before the prepared list records it.
let failNextContentRead = false;

mock.module("../../persistence/attachments-store.js", () => ({
  ...realStore,
  resolveAttachmentsForPersist: (ids: string[]) => {
    if (failNextResolve) {
      failNextResolve = false;
      throw new Error("simulated attachment read failure");
    }
    return realStore.resolveAttachmentsForPersist(ids);
  },
  linkAttachmentToMessage: (
    messageId: string,
    attachmentId: string,
    position: number,
  ) => {
    if (failNextLink) {
      failNextLink = false;
      throw new Error("simulated message_attachments write failure");
    }
    return realStore.linkAttachmentToMessage(messageId, attachmentId, position);
  },
  getAttachmentContent: (attachmentId: string) => {
    if (failNextContentRead) {
      failNextContentRead = false;
      throw new Error("simulated attachment byte read failure");
    }
    return realStore.getAttachmentContent(attachmentId);
  },
  scopeAttachmentToMessageConversation: (
    conversationId: string,
    conversationCreatedAt: number,
    attachmentId: string,
  ) => {
    if (unstorableAttachmentIds.has(attachmentId)) {
      return null;
    }
    const scoped = realStore.scopeAttachmentToMessageConversation(
      conversationId,
      conversationCreatedAt,
      attachmentId,
    );
    if (scoped) {
      scopedAttachmentIds.push(scoped.id);
    }
    return scoped;
  },
}));

// The content rewrite the repair branch performs, which is the statement that
// can throw AFTER the message row is already inserted.
import * as conversationCrudNamespace from "../../persistence/conversation-crud.js";

const realCrud = { ...conversationCrudNamespace };

let failNextContentUpdate = false;

// Armed for exactly one by-id read, which is how the "cannot tell whether the
// row landed" branch is reached.
let failNextMessageLookup = false;

// Armed for exactly one insert, which fails the persist after materialization
// has already cloned but before any row exists.
let failNextAddMessage = false;

mock.module("../../persistence/conversation-crud.js", () => ({
  ...realCrud,
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    options?: unknown,
  ) => {
    if (failNextAddMessage) {
      failNextAddMessage = false;
      throw new Error("simulated message insert failure");
    }
    return (
      realCrud.addMessage as (
        ...args: unknown[]
      ) => ReturnType<typeof realCrud.addMessage>
    )(conversationId, role, content, options);
  },
  updateMessageContent: (messageId: string, content: string) => {
    if (failNextContentUpdate) {
      failNextContentUpdate = false;
      throw new Error("simulated content rewrite failure");
    }
    return realCrud.updateMessageContent(messageId, content);
  },
  getMessageById: (messageId: string, conversationId?: string) => {
    if (failNextMessageLookup) {
      failNextMessageLookup = false;
      throw new Error("simulated message lookup failure");
    }
    return realCrud.getMessageById(messageId, conversationId);
  },
}));

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The messages-changed invalidation, which is how a client learns a row it was
// never told about is there. Recorded so a recovery can be shown to announce
// itself rather than only returning ok.
import * as resourceSyncNamespace from "../../runtime/sync/resource-sync-events.js";

const realResourceSync = { ...resourceSyncNamespace };

const messagesChangedFor: string[] = [];

mock.module("../../runtime/sync/resource-sync-events.js", () => ({
  ...realResourceSync,
  publishConversationMessagesChanged: (conversationId: string) => {
    messagesChangedFor.push(conversationId);
    return realResourceSync.publishConversationMessagesChanged(conversationId);
  },
}));

// Lexical indexing, the host-infrastructure half of the indexing gate that runs
// whatever the memory config says. Recorded so a row can be shown to stay out
// of the extraction pipeline entirely.
import * as messageLexicalNamespace from "../../persistence/job-handlers/message-lexical.js";

const realMessageLexical = { ...messageLexicalNamespace };

const lexicallyIndexed: string[] = [];

mock.module("../../persistence/job-handlers/message-lexical.js", () => ({
  ...realMessageLexical,
  enqueueLexicalIndexForMessage: (messageId: string) => {
    lexicallyIndexed.push(messageId);
    return realMessageLexical.enqueueLexicalIndexForMessage(messageId);
  },
}));

import { Conversation } from "../../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../../daemon/conversation-registry.js";
import { applySightFrameRetention } from "../../daemon/conversation-runtime-assembly.js";
import {
  addMessage,
  createConversation,
  getMessages,
  type MessageRow,
  selectSightFrameCaptureTimes,
} from "../../persistence/conversation-crud.js";
import { getConversationAttachmentsDirPath } from "../../persistence/conversation-directories.js";
import { sightFrameAttachmentIdsFromMetadata } from "../../persistence/conversation-types.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { attachments } from "../../persistence/schema.js";
import { mediaBlockAttachmentId, type Message } from "../../providers/types.js";
import {
  persistAmbientSightFrame,
  persistLiveVoicePhoto,
} from "../live-voice-photo.js";

await initializeDb();

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

function liveConversation(title: string) {
  const conversation = createConversation(title);
  const { provider } = createMockProvider([textResponse("")]);
  const activeConversation = new Conversation(
    conversation.id,
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  activeConversation.setTrustContext({
    trustClass: "guardian",
    sourceChannel: "vellum",
  });
  setConversation(conversation.id, activeConversation);
  return {
    id: conversation.id,
    createdAt: conversation.createdAt,
    activeConversation,
    dispose: () => {
      deleteConversation(conversation.id);
      activeConversation.dispose();
    },
  };
}

async function uploadFrame(name: string): Promise<string> {
  const attachment = await realStore.uploadAttachment(
    name,
    "image/png",
    IMAGE_BASE64,
  );
  return attachment.id;
}

/** A frame whose store write fails recoverably, so it persists inline. */
async function uploadUnstorableFrame(name: string): Promise<string> {
  const attachmentId = await uploadFrame(name);
  unstorableAttachmentIds.add(attachmentId);
  return attachmentId;
}

function metadataOf(row: MessageRow): Record<string, unknown> {
  return JSON.parse(row.metadata ?? "{}") as Record<string, unknown>;
}

/** True when the row kept its bytes rather than referencing an attachment. */
function hasInlineImage(row: MessageRow): boolean {
  return row.content.some(
    (block) => block.type === "image" && block.source.type === "base64",
  );
}

/** The attachment id the row's persisted image block is attributable by. */
function attributableImageId(row: MessageRow): string | undefined {
  for (const block of row.content) {
    if (block.type !== "image") {
      continue;
    }
    const id = mediaBlockAttachmentId(block);
    if (id !== undefined) {
      return id;
    }
  }
  return undefined;
}

describe("a camera frame that falls back to inline bytes", () => {
  test("is tagged by the id its own block carries", async () => {
    const live = liveConversation("Live voice inline fallback tag");
    try {
      const inlineFrame = await uploadUnstorableFrame("inline.png");

      expect(
        (await persistAmbientSightFrame(live.id, inlineFrame, "voice")).ok,
      ).toBe(true);

      const [row] = getMessages(live.id);
      // The scenario really fired: bytes in the row, no reference to a row of
      // their own, and the block naming the id the caller held.
      expect(hasInlineImage(row)).toBe(true);
      expect(attributableImageId(row)).toBe(inlineFrame);

      expect(sightFrameAttachmentIdsFromMetadata(metadataOf(row))).toEqual([
        inlineFrame,
      ]);
      // Capture times come from the tag on the row, so an id with no
      // `message_attachments` row still resolves.
      expect([...selectSightFrameCaptureTimes(live.id).keys()]).toEqual([
        inlineFrame,
      ]);
    } finally {
      live.dispose();
    }
  });

  test("is stubbed once it ages past the budget", async () => {
    // The reason the tag matters. Untagged, the one frame carrying its full
    // base64 is the one frame retention cannot touch, so it rides every later
    // request for the rest of the call.
    const live = liveConversation("Live voice inline fallback retention");
    try {
      const inlineFrame = await uploadUnstorableFrame("inline-aged.png");
      expect(
        (await persistAmbientSightFrame(live.id, inlineFrame, "voice")).ok,
      ).toBe(true);
      for (const name of ["fresh-a.png", "fresh-b.png"]) {
        const fresh = await uploadFrame(name);
        expect(
          (await persistAmbientSightFrame(live.id, fresh, "voice")).ok,
        ).toBe(true);
      }

      const assembled: Message[] = getMessages(live.id).map((row) => ({
        role: "user" as const,
        content: row.content,
      }));
      expect(assembled).toHaveLength(3);

      const retained = applySightFrameRetention(assembled, live.id);

      // Three frames, a budget of two: the inline one is the oldest, so its
      // bytes give way to the timestamped stub.
      expect(retained[0].content.some((b) => b.type === "image")).toBe(false);
      expect(
        retained[0].content.some(
          (b) =>
            b.type === "text" &&
            b.text.startsWith("[Camera frame omitted from context:"),
        ),
      ).toBe(true);
      expect(retained[1].content.some((b) => b.type === "image")).toBe(true);
      expect(retained[2].content.some((b) => b.type === "image")).toBe(true);
    } finally {
      live.dispose();
    }
  });
});

describe("a camera frame whose message link fails", () => {
  test("is repaired to inline bytes naming the id its tag names", async () => {
    // The tag is written with the row, before the link is attempted, so it
    // already names the CLONE that scoping stored. The repair rebuilds the
    // block from the caller's attachment, which names the id the session held.
    // Left disagreeing, the repaired row's frame never ages out.
    const source = liveConversation("Live voice repair source");
    const live = liveConversation("Live voice repair");
    try {
      // Linked under another conversation, so materialization clones it.
      const arrivedAs = await uploadFrame("repair.png");
      const elsewhere = await addMessage(source.id, "user", "look at this");
      realStore.linkAttachmentToMessage(elsewhere.id, arrivedAs, 0);

      failNextLink = true;
      expect(
        (await persistAmbientSightFrame(live.id, arrivedAs, "voice")).ok,
      ).toBe(true);
      expect(failNextLink).toBe(false);

      const [row] = getMessages(live.id);
      // The repair really fired: bytes in the row rather than a reference.
      expect(hasInlineImage(row)).toBe(true);

      const tagged = sightFrameAttachmentIdsFromMetadata(metadataOf(row));
      expect(tagged).toHaveLength(1);
      expect(tagged[0]).not.toBe(arrivedAs);
      // The block the retention pass reads names what the tag names.
      expect(attributableImageId(row)).toBe(tagged[0]);
    } finally {
      live.dispose();
      source.dispose();
    }
  });
});

describe("a camera frame whose persist throws", () => {
  test("keeps its attachment when the message row already exists", async () => {
    // A persist can fail well after the insert: the link write fails, the
    // repair rewrites the content, and that rewrite throws in turn. The row
    // then references the attachment with no link protecting it, which is
    // exactly what a link-aware delete reads as collectible, so reclaiming
    // would strip the image out of a message the transcript still shows.
    const live = liveConversation("Live voice throw after insert");
    try {
      const frame = await uploadFrame("throws-late.png");
      // Load once so the resident history is not stale for an unrelated
      // reason: without this the actor-scope check would reload anyway.
      await live.activeConversation.ensureActorScopedHistory();
      expect(live.activeConversation.getMessages()).toHaveLength(0);

      messagesChangedFor.length = 0;
      failNextLink = true;
      failNextContentUpdate = true;
      const result = await persistAmbientSightFrame(live.id, frame, "voice");
      expect(failNextLink).toBe(false);
      expect(failNextContentUpdate).toBe(false);

      // The row landed, so the result says so: the client keeps the frame it
      // showed instead of retracting a message the next reload would reveal.
      const [row] = getMessages(live.id);
      expect(result).toEqual({ ok: true, messageId: row.id });
      expect(realStore.getAttachmentById(frame)).not.toBeNull();
      // And the clients rendering this conversation were told.
      expect(messagesChangedFor).toContain(live.id);

      // The persist unwound its own push, so the resident history is missing
      // the row it just committed.
      expect(live.activeConversation.getMessages()).toHaveLength(0);
      // Marked stale, so the next turn rehydrates and the model sees it. The
      // trust class is unchanged from the load above, so nothing but the stale
      // mark can cause this reload.
      await live.activeConversation.ensureActorScopedHistory();
      expect(live.activeConversation.getMessages()).toHaveLength(1);
    } finally {
      live.dispose();
    }
  });

  test("recovers a photo the same way, since the row is what decides", async () => {
    // Pre-existing duplicate-photo bug: told the snap failed, the user takes
    // it again and the first one was in the transcript all along. The caller
    // sends its retract-style error frame only on ok:false, so reporting the
    // truth here is all it takes.
    const live = liveConversation("Live voice photo throw after insert");
    try {
      const photo = await uploadFrame("photo-throws-late.png");

      messagesChangedFor.length = 0;
      failNextLink = true;
      failNextContentUpdate = true;
      const result = await persistLiveVoicePhoto(live.id, photo);
      expect(failNextLink).toBe(false);
      expect(failNextContentUpdate).toBe(false);

      const [row] = getMessages(live.id);
      expect(result).toEqual({ ok: true, messageId: row.id });
      expect(realStore.getAttachmentById(photo)).not.toBeNull();
      expect(messagesChangedFor).toContain(live.id);
    } finally {
      live.dispose();
    }
  });

  test("gives up its attachment when it threw before the insert", async () => {
    // Nothing was written, so the upload is stranded exactly as a superseded
    // or timed-out keep's is.
    const live = liveConversation("Live voice throw before insert");
    try {
      const frame = await uploadFrame("throws-early.png");

      failNextResolve = true;
      expect(await persistAmbientSightFrame(live.id, frame, "voice")).toEqual({
        ok: false,
      });
      expect(failNextResolve).toBe(false);

      expect(getMessages(live.id)).toHaveLength(0);
      expect(realStore.getAttachmentById(frame)).toBeNull();
    } finally {
      live.dispose();
    }
  });

  test("keeps its attachment when it cannot tell whether the row landed", async () => {
    // Nothing was inserted here, so the frame would have been reclaimed. The
    // read that would prove it fails, and an unanswerable question resolves
    // toward leaking a row rather than risking one a message references.
    const live = liveConversation("Live voice throw with unreadable row");
    try {
      const frame = await uploadFrame("throws-unreadable.png");

      failNextResolve = true;
      failNextMessageLookup = true;
      // No success claim either: doubt blocks the delete and the ok alike.
      expect(await persistAmbientSightFrame(live.id, frame, "voice")).toEqual({
        ok: false,
      });
      expect(failNextMessageLookup).toBe(false);

      expect(getMessages(live.id)).toHaveLength(0);
      expect(realStore.getAttachmentById(frame)).not.toBeNull();
    } finally {
      live.dispose();
    }
  });
});

describe("attachments a failed persist attempt cloned for itself", () => {
  /** Link the upload under another conversation, so scoping has to clone it. */
  async function attachmentLinkedElsewhere(
    otherConversationId: string,
    name: string,
  ): Promise<string> {
    const attachmentId = await uploadFrame(name);
    const elsewhere = await addMessage(
      otherConversationId,
      "user",
      "look at this",
    );
    realStore.linkAttachmentToMessage(elsewhere.id, attachmentId, 0);
    return attachmentId;
  }

  test("the clone is given up when the insert never happened", async () => {
    // Scoping clones before the row is written, and the caller only ever holds
    // the id it sent, so a failure here strands the clone and its copied file
    // where nothing can reach them.
    const source = liveConversation("Live voice clone leak source");
    const live = liveConversation("Live voice clone leak");
    try {
      const arrivedAs = await attachmentLinkedElsewhere(
        source.id,
        "clone-leak.png",
      );
      scopedAttachmentIds.length = 0;

      failNextAddMessage = true;
      expect(
        await persistAmbientSightFrame(live.id, arrivedAs, "voice"),
      ).toEqual({
        ok: false,
      });
      expect(failNextAddMessage).toBe(false);

      const cloned = scopedAttachmentIds.at(-1);
      expect(cloned).toBeDefined();
      expect(cloned).not.toBe(arrivedAs);

      expect(getMessages(live.id)).toHaveLength(0);
      expect(realStore.getAttachmentById(cloned!)).toBeNull();
      // The caller's own upload is untouched, still held by its other
      // conversation's message.
      expect(realStore.getAttachmentById(arrivedAs)).not.toBeNull();
    } finally {
      live.dispose();
      source.dispose();
    }
  });

  test("the clone is kept when the row already references it", async () => {
    // Past the insert the persisted content names the clone while no link
    // protects it yet, so cleaning up here would strip the image out of a
    // message the transcript still shows.
    const source = liveConversation("Live voice clone kept source");
    const live = liveConversation("Live voice clone kept");
    try {
      const arrivedAs = await attachmentLinkedElsewhere(
        source.id,
        "clone-kept.png",
      );
      scopedAttachmentIds.length = 0;

      failNextLink = true;
      failNextContentUpdate = true;
      // Committed despite the throw, which is what makes the clone the row's.
      expect(
        (await persistAmbientSightFrame(live.id, arrivedAs, "voice")).ok,
      ).toBe(true);
      expect(failNextLink).toBe(false);
      expect(failNextContentUpdate).toBe(false);

      const cloned = scopedAttachmentIds.at(-1);
      expect(cloned).toBeDefined();
      expect(cloned).not.toBe(arrivedAs);

      expect(getMessages(live.id)).toHaveLength(1);
      expect(realStore.getAttachmentById(cloned!)).not.toBeNull();
      expect(realStore.getAttachmentById(arrivedAs)).not.toBeNull();
    } finally {
      live.dispose();
      source.dispose();
    }
  });

  test("a clone is given up when materialization itself throws", async () => {
    // The reference block is built between creating the row and recording it,
    // so a throw there leaves a clone the returned list never mentions. Only
    // the materialization step still knows about it, which is why it cleans up
    // its own partial work rather than leaving that to the caller.
    const source = liveConversation("Live voice partial clone source");
    const live = liveConversation("Live voice partial clone");
    try {
      const arrivedAs = await attachmentLinkedElsewhere(
        source.id,
        "partial-clone.png",
      );
      scopedAttachmentIds.length = 0;

      failNextContentRead = true;
      expect(
        await persistAmbientSightFrame(live.id, arrivedAs, "voice"),
      ).toEqual({
        ok: false,
      });
      expect(failNextContentRead).toBe(false);

      const cloned = scopedAttachmentIds.at(-1);
      expect(cloned).toBeDefined();
      expect(cloned).not.toBe(arrivedAs);

      expect(getMessages(live.id)).toHaveLength(0);
      expect(realStore.getAttachmentById(cloned!)).toBeNull();
      expect(realStore.getAttachmentById(arrivedAs)).not.toBeNull();
    } finally {
      live.dispose();
      source.dispose();
    }
  });

  test("an uncloned upload survives a failed attempt", async () => {
    // Materialization stored this one under the id it arrived with, so the row
    // IS the caller's upload and the retry they are about to make needs it.
    // A photo rather than a keep, so the live-voice reclaim (keeps only) stays
    // out of the way and the assertion isolates the persist's own cleanup.
    const live = liveConversation("Live voice uncloned survives");
    try {
      const photo = await uploadFrame("uncloned.png");

      failNextAddMessage = true;
      expect(await persistLiveVoicePhoto(live.id, photo)).toEqual({
        ok: false,
      });
      expect(failNextAddMessage).toBe(false);

      expect(getMessages(live.id)).toHaveLength(0);
      expect(realStore.getAttachmentById(photo)).not.toBeNull();
    } finally {
      live.dispose();
    }
  });
});

describe("a clone whose materialization fails", () => {
  /** Rows in the attachment store, so a leaked clone shows up as a count. */
  function attachmentRowCount(): number {
    return getDb().select({ id: attachments.id }).from(attachments).all()
      .length;
  }

  /** Give a row a real file on disk, the shape a clone inherits its path from. */
  function backWithFile(attachmentId: string, name: string): string {
    const filePath = join(tmpdir(), `sight-frame-${name}`);
    writeFileSync(filePath, Buffer.from(IMAGE_BASE64, "base64"));
    getDb()
      .update(attachments)
      .set({ filePath })
      .where(eq(attachments.id, attachmentId))
      .run();
    return filePath;
  }

  test("leaves no row behind and costs the source nothing", async () => {
    // Materialization is fallible AFTER the clone row is inserted: it copies
    // the bytes and repoints the row, and until that lands the clone still
    // names the file the bytes came FROM. A failure used to leave that row for
    // good, because the persist recovers by inlining and no error ever reached
    // the callers that clean up.
    const source = liveConversation("Live voice clone materialize source");
    const live = liveConversation("Live voice clone materialize");
    const attachDir = getConversationAttachmentsDirPath(
      live.id,
      live.createdAt,
    );
    let sourceFile: string | null = null;
    try {
      const arrivedAs = await uploadFrame("clone-materialize.png");
      const elsewhere = await addMessage(source.id, "user", "look at this");
      realStore.linkAttachmentToMessage(elsewhere.id, arrivedAs, 0);
      // The clone is inserted carrying exactly this path.
      sourceFile = backWithFile(arrivedAs, "source.png");

      const rowsBefore = attachmentRowCount();

      // A plain file where the destination's attachments directory belongs, so
      // the very first thing materialization does fails.
      mkdirSync(dirname(attachDir), { recursive: true });
      writeFileSync(attachDir, "");

      expect(
        (await persistAmbientSightFrame(live.id, arrivedAs, "voice")).ok,
      ).toBe(true);

      // The recovery is unchanged: the frame still lands, inline.
      const [row] = getMessages(live.id);
      expect(hasInlineImage(row)).toBe(true);

      // No clone row survived the failure.
      expect(attachmentRowCount()).toBe(rowsBefore);

      // The source keeps its row, the file the clone was aliasing, and its own
      // message's link.
      expect(realStore.getAttachmentById(arrivedAs)).not.toBeNull();
      expect(existsSync(sourceFile)).toBe(true);
      expect(realStore.getAttachmentsForMessage(elsewhere.id)).toHaveLength(1);
    } finally {
      rmSync(attachDir, { force: true });
      if (sourceFile) {
        rmSync(sourceFile, { force: true });
      }
      live.dispose();
      source.dispose();
    }
  });

  test("orphan collection spares a file another row still names", async () => {
    // The same aliasing seen from the other side. A clone carries the source's
    // path until materialization repoints it, so a row being collected can
    // share its file with one that outlives it, and unlinking then takes the
    // survivor's bytes.
    const kept = await uploadFrame("shared-kept.png");
    const alias = await uploadFrame("shared-alias.png");
    const sharedFile = backWithFile(kept, "shared.png");
    getDb()
      .update(attachments)
      .set({ filePath: sharedFile })
      .where(eq(attachments.id, alias))
      .run();

    try {
      expect(realStore.deleteOrphanAttachments([alias])).toBe(1);

      expect(realStore.getAttachmentById(alias)).toBeNull();
      expect(realStore.getAttachmentById(kept)).not.toBeNull();
      // The survivor's bytes are still there.
      expect(existsSync(sharedFile)).toBe(true);
    } finally {
      rmSync(sharedFile, { force: true });
    }
  });
});

describe("ambient frames stay out of the indexing pipeline", () => {
  test("a kept frame is never handed to the indexer", async () => {
    // The camera sampled it, so indexing would feed extraction a frame every
    // few seconds of whatever the room contains, and commit those visuals to
    // memory with no consent surface. The transcript is the record the design
    // signed off on.
    const live = liveConversation("Live voice keep not indexed");
    try {
      const frame = await uploadFrame("not-indexed.png");

      lexicallyIndexed.length = 0;
      expect((await persistAmbientSightFrame(live.id, frame, "voice")).ok).toBe(
        true,
      );

      const [row] = getMessages(live.id);
      expect(row).toBeDefined();
      expect(lexicallyIndexed).not.toContain(row.id);
      expect(lexicallyIndexed).toHaveLength(0);
    } finally {
      live.dispose();
    }
  });

  test("a photo is still indexed, being something the user sent", async () => {
    // Deliberate user content, and its indexing is pre-existing behavior that
    // this change must not quietly take away.
    const live = liveConversation("Live voice photo still indexed");
    try {
      const photo = await uploadFrame("still-indexed.png");

      lexicallyIndexed.length = 0;
      expect((await persistLiveVoicePhoto(live.id, photo)).ok).toBe(true);

      const [row] = getMessages(live.id);
      expect(row).toBeDefined();
      expect(lexicallyIndexed).toContain(row.id);
    } finally {
      live.dispose();
    }
  });
});
