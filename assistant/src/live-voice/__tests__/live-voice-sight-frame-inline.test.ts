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
  scopeAttachmentToMessageConversation: (
    conversationId: string,
    conversationCreatedAt: number,
    attachmentId: string,
  ) =>
    unstorableAttachmentIds.has(attachmentId)
      ? null
      : realStore.scopeAttachmentToMessageConversation(
          conversationId,
          conversationCreatedAt,
          attachmentId,
        ),
}));

// The content rewrite the repair branch performs, which is the statement that
// can throw AFTER the message row is already inserted.
import * as conversationCrudNamespace from "../../persistence/conversation-crud.js";

const realCrud = { ...conversationCrudNamespace };

let failNextContentUpdate = false;

// Armed for exactly one by-id read, which is how the "cannot tell whether the
// row landed" branch is reached.
let failNextMessageLookup = false;

mock.module("../../persistence/conversation-crud.js", () => ({
  ...realCrud,
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
import { sightFrameAttachmentIdsFromMetadata } from "../../persistence/conversation-types.js";
import { initializeDb } from "../../persistence/db-init.js";
import { mediaBlockAttachmentId, type Message } from "../../providers/types.js";
import { persistLiveVoiceSightFrame } from "../live-voice-photo.js";

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

      expect((await persistLiveVoiceSightFrame(live.id, inlineFrame)).ok).toBe(
        true,
      );

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
      expect((await persistLiveVoiceSightFrame(live.id, inlineFrame)).ok).toBe(
        true,
      );
      for (const name of ["fresh-a.png", "fresh-b.png"]) {
        const fresh = await uploadFrame(name);
        expect((await persistLiveVoiceSightFrame(live.id, fresh)).ok).toBe(
          true,
        );
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
      expect((await persistLiveVoiceSightFrame(live.id, arrivedAs)).ok).toBe(
        true,
      );
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

      failNextLink = true;
      failNextContentUpdate = true;
      expect(await persistLiveVoiceSightFrame(live.id, frame)).toEqual({
        ok: false,
      });
      expect(failNextLink).toBe(false);
      expect(failNextContentUpdate).toBe(false);

      // The row landed before the throw, so the frame is not the daemon's to
      // collect however the call reported itself.
      expect(getMessages(live.id)).toHaveLength(1);
      expect(realStore.getAttachmentById(frame)).not.toBeNull();
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
      expect(await persistLiveVoiceSightFrame(live.id, frame)).toEqual({
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
      expect(await persistLiveVoiceSightFrame(live.id, frame)).toEqual({
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
