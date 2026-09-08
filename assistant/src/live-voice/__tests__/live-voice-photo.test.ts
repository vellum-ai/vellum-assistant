import { describe, expect, mock, spyOn, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  createMockProvider,
  textResponse,
} from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";
import { waitFor } from "../../__tests__/helpers/wait-for.js";

setConfig("memory", { enabled: false });

import type { AssistantEvent } from "../../api/index.js";
import {
  Conversation,
  ProcessingClaimLostError,
} from "../../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../../daemon/conversation-registry.js";
import { applySightFrameRetention } from "../../daemon/conversation-runtime-assembly.js";
import { destroyActiveConversation } from "../../daemon/conversation-store.js";
import * as portOversized from "../../daemon/port-oversized-content.js";
import * as attachmentsStore from "../../persistence/attachments-store.js";
import {
  getAttachmentById,
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
  deleteConversation as deleteConversationRows,
  getConversation,
  getMessages,
  type MessageRow,
  selectSightFrameCaptureTimes,
} from "../../persistence/conversation-crud.js";
import { sightFrameAttachmentIdsFromMetadata } from "../../persistence/conversation-types.js";
import * as dbConnection from "../../persistence/db-connection.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { attachments, conversations } from "../../persistence/schema/index.js";
import * as slowSyncLog from "../../persistence/slow-sync-log.js";
import { mediaBlockAttachmentId, type Message } from "../../providers/types.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import {
  _drainFrameReclaimRechecksForTests,
  _nextFrameReclaimRecheckDelayForTests,
  _pendingFrameReclaimCountForTests,
  _setProcessingWaitMsForTests,
  _standaloneImageQueueSizeForTests,
  pendingStandaloneImagePersist,
  persistAmbientSightFrame,
  persistLiveVoicePhoto,
} from "../live-voice-photo.js";

await initializeDb();

/**
 * Run something in the window the persist opens between materializing an
 * attachment and inserting its row.
 *
 * `offloadOversizedText` is the last step the persist awaits before the
 * insert, so a hook here lands inside that window without a timer to race.
 * Armed per test and cleared as it fires; every other test leaves it null
 * and gets the real function.
 */
let duringPersistBeforeInsert: (() => void) | null = null;
const realPortOversized = { ...portOversized };
mock.module("../../daemon/port-oversized-content.js", () => ({
  ...realPortOversized,
  offloadOversizedText: (
    ...args: Parameters<typeof realPortOversized.offloadOversizedText>
  ) => {
    const hook = duringPersistBeforeInsert;
    duringPersistBeforeInsert = null;
    hook?.();
    return realPortOversized.offloadOversizedText(...args);
  },
}));

/**
 * Fail the next message insert the way SQLite reports contention, running
 * something first.
 *
 * `SQLITE_BUSY` is the class `withSqliteRetry` retries, so the attempt this
 * refuses is followed by an awaited backoff and another attempt. The hook runs
 * in place of the statement, which is a window no row was written in. Armed
 * per test and cleared as it fires; every other test leaves it null and the
 * insert runs for real the first time.
 */
let beforeFailingInsertAttempt: (() => void) | null = null;

/**
 * Make every store read throw, which is what leaves a persist unable to say
 * whether its row landed.
 */
let storeUnreadable = false;

/**
 * Break the store the instant a row has committed rather than before it, which
 * is the one shape where "could not read" and "the frame is in the transcript"
 * are both true.
 */
let breakStoreAfterInsert = false;

const realSlowSyncLog = { ...slowSyncLog };
mock.module("../../persistence/slow-sync-log.js", () => ({
  ...realSlowSyncLog,
  timeSyncSection: <T>(
    label: string,
    fn: () => T,
    detail?: (result: T) => Record<string, unknown>,
  ): T => {
    if (label === "messages:insert" && beforeFailingInsertAttempt) {
      const hook = beforeFailingInsertAttempt;
      beforeFailingInsertAttempt = null;
      hook();
      throw Object.assign(new Error("database is locked"), {
        code: "SQLITE_BUSY",
      });
    }
    const result = realSlowSyncLog.timeSyncSection(label, fn, detail);
    if (label === "messages:insert" && breakStoreAfterInsert) {
      breakStoreAfterInsert = false;
      storeUnreadable = true;
    }
    return result;
  },
}));

/**
 * Fail the next orphan delete the way contention does, which is the one thing
 * standing between a dropped frame and its bytes.
 */
let failNextReclaims = 0;
const realAttachmentsStore = { ...attachmentsStore };
mock.module("../../persistence/attachments-store.js", () => ({
  ...realAttachmentsStore,
  deleteOrphanAttachments: (ids: string[]) => {
    if (failNextReclaims > 0) {
      failNextReclaims -= 1;
      throw Object.assign(new Error("database is locked"), {
        code: "SQLITE_BUSY",
      });
    }
    return realAttachmentsStore.deleteOrphanAttachments(ids);
  },
}));

const realDbConnection = { ...dbConnection };
mock.module("../../persistence/db-connection.js", () => ({
  ...realDbConnection,
  getDb: () => {
    if (storeUnreadable) {
      throw new Error("database is not readable");
    }
    return realDbConnection.getDb();
  },
}));

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

/** A registered conversation the persist paths can reach, plus its teardown. */
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
    activeConversation,
    dispose: () => {
      deleteConversation(conversation.id);
      activeConversation.dispose();
    },
  };
}

function metadataOf(row: MessageRow): Record<string, unknown> {
  return JSON.parse(row.metadata ?? "{}") as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Record every `setProcessing` on a conversation and track how many holders
 * the flag believes it has. A boolean flag cannot count, so a depth above one
 * is two writers thinking they own it, and the first to finish clearing it
 * out from under the other.
 */
function watchProcessing(conversation: Conversation): {
  readonly calls: boolean[];
  depth: number;
  maxDepth: number;
} {
  const seen = { calls: [] as boolean[], depth: 0, maxDepth: 0 };
  const record = (value: boolean): void => {
    seen.calls.push(value);
    seen.depth += value ? 1 : -1;
    seen.maxDepth = Math.max(seen.maxDepth, seen.depth);
  };
  const originalSet = conversation.setProcessing.bind(conversation);
  conversation.setProcessing = (value: boolean): void => {
    record(value);
    originalSet(value);
  };
  // Standalone images take the flag through the owned acquire, and release it
  // through `releaseProcessing`, which clears via `setProcessing` above.
  const originalAcquire = conversation.acquireProcessing.bind(conversation);
  conversation.acquireProcessing = (): number | null => {
    const owner = originalAcquire();
    if (owner !== null) {
      record(true);
    }
    return owner;
  };
  return seen;
}

async function uploadFrame(name: string): Promise<string> {
  const attachment = await uploadAttachment(name, "image/png", IMAGE_BASE64);
  return attachment.id;
}

/** True while the attachment's row is still in the store. */
function frameStored(attachmentId: string): boolean {
  return getAttachmentById(attachmentId) !== null;
}

/** Collect the row announcements the hub carries for one conversation. */
function watchEchoes(conversationId: string) {
  const published: AssistantEvent[] = [];
  const subscription = assistantEventHub.subscribe({
    type: "process",
    filter: { conversationId },
    callback: (event) => {
      published.push(event.message);
    },
  });
  return {
    echoes: () => published.filter((e) => e.type === "user_message_echo"),
    dispose: () => subscription.dispose(),
  };
}

/** Every attachment row in the store, so a test can spot one made since. */
function allAttachmentIds(): string[] {
  return getDb()
    .select({ id: attachments.id })
    .from(attachments)
    .all()
    .map((row) => row.id);
}

function conversationCount(): number {
  return getDb().select({ id: conversations.id }).from(conversations).all()
    .length;
}

/**
 * Attachment ids the conversation's LIVE history is attributable by, which is
 * the array a turn sends rather than the rows a reload would rebuild.
 */
function liveImageIds(conversation: Conversation): Array<string | undefined> {
  const ids: Array<string | undefined> = [];
  for (const message of conversation.messages) {
    for (const block of message.content) {
      if (block.type === "image") {
        ids.push(mediaBlockAttachmentId(block));
      }
    }
  }
  return ids;
}

/**
 * Let a turn try to start in the instant right after the persist takes the
 * flag. The turn models a correct acquirer: it claims only what it finds free,
 * so it succeeds exactly when the persist left the flag takeable.
 */
function armTurnStartInTheGap(conversation: Conversation): {
  claimed: () => boolean;
} {
  let armed = true;
  let claimed = false;
  const acquire = conversation.acquireProcessing.bind(conversation);
  conversation.acquireProcessing = (): number | null => {
    const owner = acquire();
    if (armed && owner !== null) {
      armed = false;
      queueMicrotask(() => {
        if (acquire() !== null) {
          claimed = true;
        }
      });
    }
    return owner;
  };
  return { claimed: () => claimed };
}

/** The attachment id the row's persisted image block actually references. */
function storedImageId(row: MessageRow): string | undefined {
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

/**
 * An attachment already linked to a message in another conversation, which is
 * what makes the persist clone it rather than reuse the row.
 */
async function attachmentLinkedElsewhere(
  otherConversationId: string,
): Promise<string> {
  const attachment = await uploadAttachment(
    "frame.png",
    "image/png",
    IMAGE_BASE64,
  );
  const elsewhere = await addMessage(
    otherConversationId,
    "user",
    "look at this",
  );
  linkAttachmentToMessage(elsewhere.id, attachment.id, 0);
  return attachment.id;
}

describe("persistLiveVoicePhoto", () => {
  test("persists and echoes the image with human-readable context", async () => {
    const conversation = createConversation("Live voice photo");
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
    const attachment = await uploadAttachment(
      "photo.png",
      "image/png",
      IMAGE_BASE64,
    );
    const published: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      filter: { conversationId: conversation.id },
      callback: (event) => {
        published.push(event.message);
      },
    });

    try {
      const result = await persistLiveVoicePhoto(
        conversation.id,
        attachment.id,
      );
      expect(result.ok).toBe(true);

      await waitFor(
        () => published.some((event) => event.type === "user_message_echo"),
        { message: "Timed out waiting for live-voice photo echo" },
      );

      const [message] = getMessages(conversation.id);
      if (!message) {
        throw new Error("Live-voice photo message was not persisted");
      }
      expect(message.content.filter((block) => block.type === "text")).toEqual([
        { type: "text", text: "here's a photo:" },
      ]);
      expect(getAttachmentsForMessage(message.id)).toHaveLength(1);
      expect(
        published.find((event) => event.type === "user_message_echo"),
      ).toMatchObject({
        type: "user_message_echo",
        text: "here's a photo:",
        conversationId: conversation.id,
        messageId: message.id,
      });
    } finally {
      subscription.dispose();
      deleteConversation(conversation.id);
      activeConversation.dispose();
    }
  });

  test("leaves the photo untagged, so retention never ages it out", async () => {
    // A photo the user chose to take is not an ambient frame; the sight tag
    // would hand it to the pass that stubs frames out of the context.
    const live = liveConversation("Live voice photo untagged");
    try {
      const attachment = await uploadAttachment(
        "photo.png",
        "image/png",
        IMAGE_BASE64,
      );

      const result = await persistLiveVoicePhoto(live.id, attachment.id);
      expect(result.ok).toBe(true);

      expect(selectSightFrameCaptureTimes(live.id).size).toBe(0);
    } finally {
      live.dispose();
    }
  });

  test("leaves the photo unscripted, the shutter being a turn the user took", async () => {
    // Pressing the shutter is the user acting, so the row keeps asserting
    // "the user did this" and stays inside activation.
    const live = liveConversation("Live voice photo scripted");
    try {
      const attachment = await uploadAttachment(
        "photo.png",
        "image/png",
        IMAGE_BASE64,
      );

      expect((await persistLiveVoicePhoto(live.id, attachment.id)).ok).toBe(
        true,
      );

      expect(metadataOf(getMessages(live.id)[0]).scripted).toBe(false);
    } finally {
      live.dispose();
    }
  });
});

describe("persistAmbientSightFrame", () => {
  test("tags the row with the attachment it carries", async () => {
    const live = liveConversation("Live voice sight frame");
    try {
      const attachment = await uploadAttachment(
        "frame.png",
        "image/png",
        IMAGE_BASE64,
      );

      const result = await persistAmbientSightFrame(
        live.id,
        attachment.id,
        "voice",
      );
      expect(result.ok).toBe(true);

      const [message] = getMessages(live.id);
      expect(message.content.filter((block) => block.type === "text")).toEqual([
        { type: "text", text: "(camera frame)" },
      ]);
      expect(getAttachmentsForMessage(message.id)).toHaveLength(1);
      // Readable by the retention pass, which is the whole point of the tag.
      expect([...selectSightFrameCaptureTimes(live.id).keys()]).toEqual([
        attachment.id,
      ]);
    } finally {
      live.dispose();
    }
  });

  test("marks the row scripted, so keeps are not counted as turns the user took", async () => {
    // The gate sent this, not the user. A keep every few seconds would
    // otherwise read downstream as that many turns taken, and activation
    // believes a row that claims it was typed.
    const live = liveConversation("Live voice sight frame scripted");
    try {
      const attachment = await uploadAttachment(
        "frame.png",
        "image/png",
        IMAGE_BASE64,
      );

      expect(
        (await persistAmbientSightFrame(live.id, attachment.id, "voice")).ok,
      ).toBe(true);

      expect(metadataOf(getMessages(live.id)[0]).scripted).toBe(true);
    } finally {
      live.dispose();
    }
  });

  test("marks a keep taken on a call as a voice session turn", async () => {
    // The mark says a reply to this row is spoken back over a session that is
    // still open, which decides whether a finished reply raises a push. Only
    // the voice surface may claim it, and it has to keep claiming it.
    const live = liveConversation("Live voice sight frame voice mark");
    try {
      const attachment = await uploadAttachment(
        "frame.png",
        "image/png",
        IMAGE_BASE64,
      );

      expect(
        (await persistAmbientSightFrame(live.id, attachment.id, "voice")).ok,
      ).toBe(true);

      expect(metadataOf(getMessages(live.id)[0]).voiceSessionTurn).toBe(true);
    } finally {
      live.dispose();
    }
  });

  test("tags the id the attachment was cloned into, not the one it arrived as", async () => {
    // An attachment already linked to another conversation is cloned into this
    // one under a fresh id, and both the persisted block and the link carry the
    // clone. A tag naming the id the caller held would match nothing.
    const source = liveConversation("Live voice sight frame source");
    const live = liveConversation("Live voice sight frame clone");
    try {
      const arrivedAs = await attachmentLinkedElsewhere(source.id);

      expect(
        (await persistAmbientSightFrame(live.id, arrivedAs, "voice")).ok,
      ).toBe(true);

      const [row] = getMessages(live.id);
      const stored = storedImageId(row);
      expect(stored).toBeDefined();
      expect(stored).not.toBe(arrivedAs);
      expect(sightFrameAttachmentIdsFromMetadata(metadataOf(row))).toEqual([
        stored!,
      ]);
      expect([...selectSightFrameCaptureTimes(live.id).keys()]).toEqual([
        stored!,
      ]);
    } finally {
      live.dispose();
      source.dispose();
    }
  });

  test("the live in-memory block names the cloned id, not the arriving one", async () => {
    // The live message is built from the attachments the caller handed in, so
    // its block names the id the session held while the tag names what
    // materialization stored. Left disagreeing, the turn that created the
    // frame sends it full size and only a reload ever bounds it.
    const source = liveConversation("Live voice live block source");
    const live = liveConversation("Live voice live block clone");
    try {
      const arrivedAs = await attachmentLinkedElsewhere(source.id);

      expect(
        (await persistAmbientSightFrame(live.id, arrivedAs, "voice")).ok,
      ).toBe(true);

      const stored = storedImageId(getMessages(live.id)[0]);
      expect(stored).toBeDefined();
      expect(stored).not.toBe(arrivedAs);
      // The array a turn actually sends agrees with the tag.
      expect(liveImageIds(live.activeConversation)).toEqual([stored]);
    } finally {
      live.dispose();
      source.dispose();
    }
  });

  test("retention ages a cloned frame in the live history", async () => {
    // The reload path is covered below; this is the same conversation before
    // any reload, which is where a long call spends all its time.
    const source = liveConversation("Live voice live retention source");
    const live = liveConversation("Live voice live retention");
    try {
      const arrivedAs = await attachmentLinkedElsewhere(source.id);
      expect(
        (await persistAmbientSightFrame(live.id, arrivedAs, "voice")).ok,
      ).toBe(true);
      for (const name of ["live-fresh-a.png", "live-fresh-b.png"]) {
        const fresh = await uploadFrame(name);
        expect(
          (await persistAmbientSightFrame(live.id, fresh, "voice")).ok,
        ).toBe(true);
      }

      const live_ = live.activeConversation;
      expect(live_.messages).toHaveLength(3);
      const retained = live_.trimAgedSightFrames(live_.messages);

      // Three frames, a budget of two: the cloned one is the oldest and goes.
      expect(retained[0].content.some((b) => b.type === "image")).toBe(false);
      expect(retained[1].content.some((b) => b.type === "image")).toBe(true);
      expect(retained[2].content.some((b) => b.type === "image")).toBe(true);
    } finally {
      live.dispose();
      source.dispose();
    }
  });

  test("retention ages a cloned frame, because the tag matches its block", async () => {
    // The end of the same thread: a tag naming the id the caller held leaves
    // this frame unrecognized, so it is never counted and never stubbed, and
    // it rides every later request for the rest of the call.
    const source = liveConversation("Live voice cloned retention source");
    const live = liveConversation("Live voice cloned retention");
    try {
      const arrivedAs = await attachmentLinkedElsewhere(source.id);
      expect(
        (await persistAmbientSightFrame(live.id, arrivedAs, "voice")).ok,
      ).toBe(true);
      for (const name of ["later-a.png", "later-b.png"]) {
        const fresh = await uploadAttachment(name, "image/png", IMAGE_BASE64);
        expect(
          (await persistAmbientSightFrame(live.id, fresh.id, "voice")).ok,
        ).toBe(true);
      }

      const assembled: Message[] = getMessages(live.id).map((row) => ({
        role: "user" as const,
        content: row.content,
      }));
      const retained = applySightFrameRetention(assembled, live.id);

      // Three frames, a budget of two: the cloned one is the oldest and goes.
      expect(retained[0].content.some((b) => b.type === "image")).toBe(false);
      expect(retained[1].content.some((b) => b.type === "image")).toBe(true);
      expect(retained[2].content.some((b) => b.type === "image")).toBe(true);
    } finally {
      live.dispose();
      source.dispose();
    }
  });

  test("reports a frame whose attachment does not resolve", async () => {
    const live = liveConversation("Live voice sight frame missing");
    try {
      expect(
        await persistAmbientSightFrame(live.id, "att-missing", "voice"),
      ).toEqual({
        ok: false,
      });
      expect(getMessages(live.id)).toHaveLength(0);
    } finally {
      live.dispose();
    }
  });

  test("waits out an in-flight turn instead of splitting its rows", async () => {
    // A keep landing mid-reply must neither interrupt the reply nor land
    // between the rows the reply persists. The processing lock is what orders
    // them: the keep takes it only once the turn has let go.
    const live = liveConversation("Live voice sight frame interleave");
    try {
      const attachment = await uploadAttachment(
        "frame.png",
        "image/png",
        IMAGE_BASE64,
      );

      live.activeConversation.setProcessing(true);
      const pending = persistAmbientSightFrame(live.id, attachment.id, "voice");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(getMessages(live.id)).toHaveLength(0);

      // The turn's own persist, while it still holds the lock.
      await addMessage(live.id, "assistant", "still looking");
      live.activeConversation.setProcessing(false);
      expect(await pending).toMatchObject({ ok: true });

      const rows = getMessages(live.id);
      expect(rows.map((row) => row.role)).toEqual(["assistant", "user"]);
    } finally {
      live.dispose();
    }
  });
});

describe("standalone image persists are serialized per conversation", () => {
  test("two images arriving together take the flag one at a time", async () => {
    // The window the boolean flag cannot survive. Both persists interleave
    // across the awaits between reading the flag and taking it, so both read
    // idle and both take it; unserialized the calls come out
    // [true, true, false, false], and that first `false` lands while the
    // second write is still going, leaving a spoken turn free to launch into
    // a half-written row and the second finisher free to clear that turn's
    // flag.
    const live = liveConversation("Live voice concurrent images");
    const seen = watchProcessing(live.activeConversation);
    try {
      const photo = await uploadFrame("snap.png");
      const frame = await uploadFrame("ambient.png");

      const photoWrite = persistLiveVoicePhoto(live.id, photo);
      const frameWrite = persistAmbientSightFrame(live.id, frame, "voice");

      expect(await photoWrite).toMatchObject({ ok: true });
      expect(await frameWrite).toMatchObject({ ok: true });

      // One holder at a time, so no release lands while another write is in
      // flight, and every take is answered before the next one.
      expect(seen.calls).toEqual([true, false, true, false]);
      expect(seen.maxDepth).toBe(1);
      expect(seen.depth).toBe(0);
      expect(getMessages(live.id)).toHaveLength(2);
    } finally {
      live.dispose();
    }
  });

  test("two frames waiting out one turn write one at a time", async () => {
    // The same invariant across the wait path: both jobs sit behind a running
    // turn, and the chain still hands the flag over one at a time when it
    // ends.
    const live = liveConversation("Live voice serialized keeps");
    const seen = watchProcessing(live.activeConversation);
    try {
      const first = await uploadFrame("first.png");
      const second = await uploadFrame("second.png");

      live.activeConversation.setProcessing(true);
      const firstKeep = persistAmbientSightFrame(live.id, first, "voice");
      // Long enough for the first keep to reach the idle wait, so the second
      // queues behind a job that has already begun rather than replacing it.
      await sleep(30);
      const secondKeep = persistAmbientSightFrame(live.id, second, "voice");
      await sleep(30);
      live.activeConversation.setProcessing(false);

      expect(await firstKeep).toMatchObject({ ok: true });
      expect(await secondKeep).toMatchObject({ ok: true });

      expect(seen.maxDepth).toBe(1);
      expect(seen.depth).toBe(0);
      expect(getMessages(live.id)).toHaveLength(2);
    } finally {
      live.dispose();
    }
  });

  test("a turn starting in the gap keeps the flag it claimed", async () => {
    // The flag is a boolean with no owner, so reading it free and taking it
    // have to be one step. Split by an await, a turn claims it in between and
    // the frame writes over a turn that got there first, then clears the flag
    // that turn is still holding.
    const live = liveConversation("Live voice turn start race");
    try {
      const frame = await uploadFrame("race.png");

      // A turn is running, so the keep goes into the wait.
      live.activeConversation.setProcessing(true);
      const keep = persistAmbientSightFrame(live.id, frame, "voice");
      await sleep(150);

      // From here, the next observation of a free flag lets a turn try to
      // start in the following microtask.
      const turn = armTurnStartInTheGap(live.activeConversation);
      live.activeConversation.setProcessing(false);

      expect(await keep).toMatchObject({ ok: true });

      // The keep took the flag in the same step it read it free, so the turn
      // found it busy and never claimed it.
      expect(turn.claimed()).toBe(false);
      expect(live.activeConversation.isProcessing()).toBe(false);
      expect(getMessages(live.id)).toHaveLength(1);
    } finally {
      live.dispose();
    }
  });

  test("a frame does not write into or release a turn that claimed the flag", async () => {
    // A turn claims the flag unconditionally, which is how every turn starts.
    // The frame's write fence reads the claim as no longer its own and refuses
    // the row, and its release is refused for the same reason, so the turn
    // keeps a conversation nothing else wrote into.
    const live = liveConversation("Live voice keep flag claimed away");
    try {
      const frame = await uploadFrame("claimed-away.png");

      duringPersistBeforeInsert = () => {
        live.activeConversation.setProcessing(true);
      };

      expect(await persistAmbientSightFrame(live.id, frame, "voice")).toEqual({
        ok: false,
      });

      expect(getMessages(live.id)).toHaveLength(0);
      // The turn still holds it: the frame released only its own claim.
      expect(live.activeConversation.isProcessing()).toBe(true);
    } finally {
      duringPersistBeforeInsert = null;
      live.activeConversation.setProcessing(false);
      live.dispose();
    }
  });

  test("an acquire keeps the flag when its advisory write cannot land", async () => {
    // The window a strict set opened: reverting the flag because an advisory
    // write lost a race to contention publishes an idle conversation for as
    // long as the caller's retry sleeps, and anything polling for idle takes
    // it while that caller believes its own turn is starting.
    const live = liveConversation("Live voice acquire mirror failure");
    try {
      storeUnreadable = true;
      const owner = live.activeConversation.acquireProcessing();
      storeUnreadable = false;

      expect(owner).not.toBeNull();
      expect(live.activeConversation.isProcessing()).toBe(true);
      // Held, so nothing else can take it.
      expect(live.activeConversation.acquireProcessing()).toBeNull();

      // A claim that is not the live one releases nothing.
      expect(live.activeConversation.releaseProcessing(owner! - 1)).toBe(false);
      expect(live.activeConversation.isProcessing()).toBe(true);

      expect(live.activeConversation.releaseProcessing(owner!)).toBe(true);
      expect(live.activeConversation.isProcessing()).toBe(false);
    } finally {
      storeUnreadable = false;
      live.dispose();
    }
  });

  test("an acquire does not proceed until its processing marker lands", async () => {
    // `processing_started_at` is what a reconnecting client and the
    // out-of-process retrospective worker read to decide a turn is live, so a
    // turn that writes rows while the column is null lets a client stop
    // waiting mid-turn and lets the worker fork partial history.
    const live = liveConversation("Live voice marker fence");
    try {
      const owner = live.activeConversation.acquireProcessing();
      expect(owner).not.toBeNull();

      // Held for the whole write, so no second acquirer can slip in behind a
      // marker that is still landing.
      expect(live.activeConversation.isProcessing()).toBe(true);
      await live.activeConversation.ensureProcessingMarker(owner!);

      expect(
        getDb()
          .select({ startedAt: conversations.processingStartedAt })
          .from(conversations)
          .where(eq(conversations.id, live.id))
          .get()?.startedAt,
      ).not.toBeNull();

      expect(live.activeConversation.releaseProcessing(owner!)).toBe(true);
    } finally {
      live.dispose();
    }
  });

  test("a claim whose marker will not land is given back", async () => {
    // The fence has to fail closed: a hold nobody can see is worse than an
    // operation that reports it could not start.
    const live = liveConversation("Live voice marker fence failure");
    try {
      storeUnreadable = true;
      const owner = live.activeConversation.acquireProcessing();
      expect(owner).not.toBeNull();

      await expect(
        live.activeConversation.ensureProcessingMarker(owner!),
      ).rejects.toThrow();
      storeUnreadable = false;

      // The caller gives the hold back, and the flag is free again.
      expect(live.activeConversation.releaseProcessing(owner!)).toBe(true);
      expect(live.activeConversation.isProcessing()).toBe(false);
    } finally {
      storeUnreadable = false;
      live.dispose();
    }
  });

  test("a deferred reclaim collects the clone, not just the id it was handed", async () => {
    // A frame already linked to another conversation is CLONED into this one
    // before the insert precondition runs. If the precondition then refuses
    // and the persist's own clone cleanup hits contention, retrying under the
    // caller's id reclaims nothing: that row is still linked where it came
    // from, and the clone nobody names survives every pass.
    const source = liveConversation("Live voice clone reclaim source");
    const live = liveConversation("Live voice clone reclaim");
    try {
      const arrivedAs = await attachmentLinkedElsewhere(source.id);
      const beforePersist = new Set(allAttachmentIds());

      // Replaced mid-persist, so the precondition refuses after the clone was
      // made, and the clone cleanup that follows fails once on contention.
      duringPersistBeforeInsert = () => {
        deleteConversationRows(live.id);
        createConversation({ id: live.id, title: "Recreated" });
        // The persist's own clone cleanup fails, and so does the reclaim that
        // follows it, so the record reaches the deferred pass.
        failNextReclaims = 2;
      };

      expect(
        await persistAmbientSightFrame(live.id, arrivedAs, "voice"),
      ).toEqual({ ok: false });

      expect(getMessages(live.id)).toHaveLength(0);
      expect(_pendingFrameReclaimCountForTests()).toBe(1);
      // The clone outlived the failed cleanup, so something still owes it.
      const clones = allAttachmentIds().filter((id) => !beforePersist.has(id));
      expect(clones).toHaveLength(1);
      expect(frameStored(clones[0])).toBe(true);

      _drainFrameReclaimRechecksForTests();

      expect(_pendingFrameReclaimCountForTests()).toBe(0);
      // The clone is gone, and the original it was copied from is untouched
      // and still linked to the message that owns it.
      expect(frameStored(clones[0])).toBe(false);
      expect(frameStored(arrivedAs)).toBe(true);
      expect(
        getAttachmentsForMessage(getMessages(source.id)[0].id),
      ).toHaveLength(1);
    } finally {
      duringPersistBeforeInsert = null;
      failNextReclaims = 0;
      live.dispose();
      source.dispose();
    }
  });

  test("a fence whose claim was cleared under it reports the loss", async () => {
    // The caller does its work between the fence and its release, so a fence
    // that answered "fine" for a hold Stop or a teardown already cleared would
    // let that work run under a dead claim while a new turn acquires and
    // writes alongside it.
    const live = liveConversation("Live voice fence claim cleared");
    try {
      const owner = live.activeConversation.acquireProcessing();
      expect(owner).not.toBeNull();

      // The teardown shape: an unconditional clear while the marker is still
      // the live claim's.
      live.activeConversation.setProcessing(false);

      await expect(
        live.activeConversation.ensureProcessingMarker(owner!),
      ).rejects.toThrow(ProcessingClaimLostError);
    } finally {
      live.dispose();
    }
  });

  test("a fence whose claim is taken away after the write reports the loss", async () => {
    // The other half of the same window: the marker lands, and the hold is
    // claimed away before the awaiter resumes. The fence answers for the
    // present, not for the moment it started waiting.
    const live = liveConversation("Live voice fence claim stolen");
    try {
      const owner = live.activeConversation.acquireProcessing();
      expect(owner).not.toBeNull();

      const fence = live.activeConversation.ensureProcessingMarker(owner!);
      // A turn claiming the flag, which is how every turn starts.
      live.activeConversation.setProcessing(true);

      await expect(fence).rejects.toThrow(ProcessingClaimLostError);
    } finally {
      live.activeConversation.setProcessing(false);
      live.dispose();
    }
  });

  test("a fenced acquire reads a lost claim as a busy conversation", async () => {
    // Callers owe one answer for "this conversation is someone else's",
    // however it became so, and the fenced acquire is what collapses the two
    // routes into it. The claim is given back on the way out.
    const live = liveConversation("Live voice fenced acquire loss");
    try {
      const marker = spyOn(
        live.activeConversation,
        "ensureProcessingMarker",
      ).mockImplementation(async () => {
        throw new ProcessingClaimLostError(live.id);
      });

      expect(
        await live.activeConversation.acquireProcessingFenced(),
      ).toBeNull();
      // Not left held: the next acquire finds it free.
      expect(live.activeConversation.isProcessing()).toBe(false);

      marker.mockRestore();
      expect(
        await live.activeConversation.acquireProcessingFenced(),
      ).not.toBeNull();
    } finally {
      live.activeConversation.setProcessing(false);
      live.dispose();
    }
  });

  test("a fenced acquire that cannot persist its marker leaves nothing held", async () => {
    // The P2 shape. A marker that will not land is a real failure, and the
    // claim has to be gone before the throw reaches the caller, or the
    // conversation is stuck processing with sends queuing behind a dead hold.
    const live = liveConversation("Live voice fenced acquire marker failure");
    try {
      const marker = spyOn(
        live.activeConversation,
        "ensureProcessingMarker",
      ).mockImplementation(async () => {
        throw new Error("database is not readable");
      });

      await expect(
        live.activeConversation.acquireProcessingFenced(),
      ).rejects.toThrow("database is not readable");

      expect(live.activeConversation.isProcessing()).toBe(false);
      marker.mockRestore();
    } finally {
      live.activeConversation.setProcessing(false);
      live.dispose();
    }
  });

  test("a keep does not write under a claim a Stop took away mid-write", async () => {
    // Stop on a standalone hold force-clears the flag, because no turn owns
    // the claim to signal, and the next request acquires. The incarnation is
    // unchanged, so without the ownership term the frame writes under a dead
    // claim alongside the turn that now holds the conversation, and the
    // refused release afterwards cannot undo the row.
    const live = liveConversation("Live voice keep stopped mid-write");
    try {
      const frame = await uploadFrame("stopped-mid-write.png");

      duringPersistBeforeInsert = () => {
        // What `abortConversation` does for a hold with no live turn behind
        // it, followed by the next request taking the conversation.
        live.activeConversation.setProcessing(false);
        expect(live.activeConversation.acquireProcessing()).not.toBeNull();
      };

      expect(await persistAmbientSightFrame(live.id, frame, "voice")).toEqual({
        ok: false,
      });

      expect(getMessages(live.id)).toHaveLength(0);
      expect(frameStored(frame)).toBe(false);
      // The claim taken during the Stop is untouched by the frame's release.
      expect(live.activeConversation.isProcessing()).toBe(true);
    } finally {
      duringPersistBeforeInsert = null;
      live.activeConversation.setProcessing(false);
      live.dispose();
    }
  });

  test("a newer keep replaces one that is still waiting to start", async () => {
    // The chain is bounded this way: keeps arrive every few seconds while each
    // job can wait out a turn for far longer, so a queued keep that a newer
    // one has already made stale is given up rather than stacked.
    const live = liveConversation("Live voice coalesced keeps");
    try {
      const running = await uploadFrame("running.png");
      const stale = await uploadFrame("stale.png");
      const newest = await uploadFrame("newest.png");

      live.activeConversation.setProcessing(true);
      const runningKeep = persistAmbientSightFrame(live.id, running, "voice");
      await sleep(30);
      const staleKeep = persistAmbientSightFrame(live.id, stale, "voice");
      const newestKeep = persistAmbientSightFrame(live.id, newest, "voice");
      await sleep(30);
      live.activeConversation.setProcessing(false);

      // The one that had already begun still lands; the one it displaced is
      // reported to its caller as the single lost frame it is.
      expect(await runningKeep).toMatchObject({ ok: true });
      expect(await staleKeep).toEqual({ ok: false });
      expect(await newestKeep).toMatchObject({ ok: true });

      expect(
        [...selectSightFrameCaptureTimes(live.id).keys()].sort(),
      ).toHaveLength(2);
      expect(getMessages(live.id)).toHaveLength(2);

      // The client uploaded the displaced frame and the daemon chose to drop
      // it, so this is the only thing that will ever collect it: the client's
      // own abandon-delete fires on a refused send, and this send succeeded.
      expect(frameStored(stale)).toBe(false);
      // The two that reached a message are not this reclaim's to touch.
      expect(frameStored(running)).toBe(true);
      expect(frameStored(newest)).toBe(true);
    } finally {
      live.dispose();
    }
  });

  test("queued photos are never replaced", async () => {
    // The user watched themselves take each one, so none of them is stale.
    const live = liveConversation("Live voice queued photos");
    try {
      const ids = [
        await uploadFrame("one.png"),
        await uploadFrame("two.png"),
        await uploadFrame("three.png"),
      ];

      live.activeConversation.setProcessing(true);
      const writes = ids.map((id) => persistLiveVoicePhoto(live.id, id));
      await sleep(30);
      live.activeConversation.setProcessing(false);

      for (const result of await Promise.all(writes)) {
        expect(result).toMatchObject({ ok: true });
      }
      expect(getMessages(live.id)).toHaveLength(3);
      // Nothing is ever reclaimed on the photo path: none of them was dropped.
      for (const id of ids) {
        expect(frameStored(id)).toBe(true);
      }
    } finally {
      live.dispose();
    }
  });

  test("a keep whose wait runs out gives up its upload", async () => {
    // A turn longer than the wait drops the keep, and nothing else would ever
    // collect the row: the client's abandon-delete fires on a refused send,
    // and this send was accepted.
    const restoreWait = _setProcessingWaitMsForTests(120);
    const live = liveConversation("Live voice keep wait timeout");
    try {
      const frame = await uploadFrame("timed-out.png");

      // A turn that outlasts the wait.
      live.activeConversation.setProcessing(true);
      expect(await persistAmbientSightFrame(live.id, frame, "voice")).toEqual({
        ok: false,
      });

      expect(frameStored(frame)).toBe(false);
      expect(getMessages(live.id)).toHaveLength(0);
      // The delete took first try, so nothing is left waiting on the store.
      expect(_pendingFrameReclaimCountForTests()).toBe(0);
    } finally {
      live.activeConversation.setProcessing(false);
      live.dispose();
      _setProcessingWaitMsForTests(restoreWait);
    }
  });

  test("a reclaim the store refuses is retried until it takes", async () => {
    // The refusal already told the client the daemon owns the upload, so a
    // delete that fails on the same contention everything else here waits out
    // cannot just be logged: the record is the only handle left on the bytes.
    const restoreWait = _setProcessingWaitMsForTests(120);
    const live = liveConversation("Live voice keep reclaim contention");
    try {
      const frame = await uploadFrame("reclaim-contention.png");

      // A turn that outlasts the wait, so the keep is dropped and its upload
      // becomes the daemon's to collect.
      live.activeConversation.setProcessing(true);
      failNextReclaims = 1;
      expect(await persistAmbientSightFrame(live.id, frame, "voice")).toEqual({
        ok: false,
      });

      expect(frameStored(frame)).toBe(true);
      expect(_pendingFrameReclaimCountForTests()).toBe(1);

      // The recheck's own delete can fail too, and that keeps the record
      // rather than spending it.
      failNextReclaims = 1;
      _drainFrameReclaimRechecksForTests();
      expect(frameStored(frame)).toBe(true);
      expect(_pendingFrameReclaimCountForTests()).toBe(1);

      _drainFrameReclaimRechecksForTests();

      expect(_pendingFrameReclaimCountForTests()).toBe(0);
      expect(frameStored(frame)).toBe(false);
      expect(getMessages(live.id)).toHaveLength(0);
    } finally {
      failNextReclaims = 0;
      live.activeConversation.setProcessing(false);
      live.dispose();
      _setProcessingWaitMsForTests(restoreWait);
    }
  });

  test("a photo whose wait runs out keeps its upload", async () => {
    // A photo is a deliberate upload the user watched themselves make, so a
    // failed persist is theirs to retry rather than the daemon's to delete.
    const restoreWait = _setProcessingWaitMsForTests(120);
    const live = liveConversation("Live voice photo wait timeout");
    try {
      const photo = await uploadFrame("timed-out-photo.png");

      live.activeConversation.setProcessing(true);
      expect(await persistLiveVoicePhoto(live.id, photo)).toEqual({
        ok: false,
      });

      expect(frameStored(photo)).toBe(true);
      expect(getMessages(live.id)).toHaveLength(0);
    } finally {
      live.activeConversation.setProcessing(false);
      live.dispose();
      _setProcessingWaitMsForTests(restoreWait);
    }
  });

  test("a deletion is final for a keep still queued behind another", async () => {
    // The persist reaches its conversation through `getOrCreateConversation`,
    // which writes the row back for an id it finds missing. A keep that was
    // queued when the delete landed would therefore bring the conversation
    // back holding nothing but camera frames, so the job re-reads before it
    // touches anything.
    const restoreWait = _setProcessingWaitMsForTests(150);
    const live = liveConversation("Live voice keep deleted mid-queue");
    const holder = await uploadFrame("voice-holder.png");
    const queued = await uploadFrame("voice-queued.png");
    try {
      live.activeConversation.setProcessing(true);
      const holderKeep = persistAmbientSightFrame(live.id, holder, "voice");
      await sleep(30);
      const queuedKeep = persistAmbientSightFrame(live.id, queued, "voice");

      destroyActiveConversation(live.id, { keepSubagentRecords: true });
      deleteConversationRows(live.id);
      const countAfterDelete = conversationCount();

      expect(await holderKeep).toEqual({ ok: false });
      expect(await queuedKeep).toEqual({ ok: false });

      expect(getConversation(live.id)).toBeNull();
      expect(conversationCount()).toBe(countAfterDelete);
      expect(getMessages(live.id)).toHaveLength(0);
      expect(frameStored(queued)).toBe(false);
    } finally {
      _setProcessingWaitMsForTests(restoreWait);
    }
  });

  test("a keep does not land in a conversation recreated under its id", async () => {
    // The job holds its instance across the idle wait rather than re-reading,
    // so a delete alone is caught only by the messages foreign key. A recreate
    // under the same id restores that foreign key's target, and the frame
    // would land in a conversation made after the deletion.
    const live = liveConversation("Live voice keep recreated id");
    try {
      const frame = await uploadFrame("recreated.png");

      // A turn the keep has to wait out, which is the window the delete and
      // the recreate land in.
      live.activeConversation.setProcessing(true);
      const keep = persistAmbientSightFrame(live.id, frame, "voice");
      await sleep(30);

      // The same id, naming a conversation the keep was never taken in.
      deleteConversationRows(live.id);
      createConversation({ id: live.id, title: "Recreated" });
      live.activeConversation.setProcessing(false);

      expect(await keep).toEqual({ ok: false });

      expect(getMessages(live.id)).toHaveLength(0);
      expect(frameStored(frame)).toBe(false);
    } finally {
      live.dispose();
    }
  });

  test("a keep waiting its turn in the chain does not land in a replacement", async () => {
    // The incarnation a frame is accepted for is read before it is queued, not
    // when its job starts. The chain can hold a keep behind another image for
    // as long as a turn runs, and a job that read the id when it began would
    // read the replacement and then check it against itself.
    const live = liveConversation("Live voice keep queued behind another");
    const holder = await uploadFrame("chain-holder.png");
    const queued = await uploadFrame("chain-queued.png");
    try {
      // A turn the first keep waits out, which is what keeps the second one
      // chained rather than started.
      live.activeConversation.setProcessing(true);
      const holderKeep = persistAmbientSightFrame(live.id, holder, "voice");
      await sleep(30);
      const queuedKeep = persistAmbientSightFrame(live.id, queued, "voice");

      // The same id, naming a conversation neither frame was taken in.
      deleteConversationRows(live.id);
      createConversation({ id: live.id, title: "Recreated" });
      live.activeConversation.setProcessing(false);

      expect(await holderKeep).toEqual({ ok: false });
      expect(await queuedKeep).toEqual({ ok: false });

      expect(getMessages(live.id)).toHaveLength(0);
      expect(frameStored(holder)).toBe(false);
      expect(frameStored(queued)).toBe(false);
    } finally {
      live.dispose();
    }
  });

  test("a keep is refused by a conversation recreated in the same millisecond", async () => {
    // `created_at` is the whole of an incarnation's identity, so two rows
    // stamped from one wall-clock millisecond would read as the same
    // conversation and every fence would pass. The stamp is issued
    // monotonically, which is what keeps the two apart.
    const live = liveConversation("Live voice same millisecond recreate");
    try {
      const frame = await uploadFrame("same-millisecond.png");
      const takenIn = getConversation(live.id)!.createdAt;

      live.activeConversation.setProcessing(true);
      const keep = persistAmbientSightFrame(live.id, frame, "voice");
      await sleep(30);

      const clock = spyOn(Date, "now").mockReturnValue(takenIn);
      try {
        deleteConversationRows(live.id);
        createConversation({ id: live.id, title: "Recreated" });
      } finally {
        clock.mockRestore();
      }
      expect(getConversation(live.id)!.createdAt).not.toBe(takenIn);

      live.activeConversation.setProcessing(false);

      expect(await keep).toEqual({ ok: false });
      expect(getMessages(live.id)).toHaveLength(0);
      expect(frameStored(frame)).toBe(false);
    } finally {
      live.dispose();
    }
  });

  test("a keep does not land in a conversation replaced during its write", async () => {
    // The check before the persist answers only for the moment it ran. The
    // persist then materializes the frame and builds its content, all awaited,
    // and a delete and recreate under the same id landing in any of those
    // windows restores the messages foreign key's target, so nothing else
    // stops the frame joining a conversation it was never taken in.
    const live = liveConversation("Live voice keep replaced mid-write");
    try {
      const frame = await uploadFrame("mid-write.png");

      duringPersistBeforeInsert = () => {
        deleteConversationRows(live.id);
        createConversation({ id: live.id, title: "Recreated" });
      };

      expect(await persistAmbientSightFrame(live.id, frame, "voice")).toEqual({
        ok: false,
      });

      expect(getMessages(live.id)).toHaveLength(0);
      // Nothing else would ever collect it: the client's abandon-delete fires
      // on a refused send, and this send was accepted.
      expect(frameStored(frame)).toBe(false);
    } finally {
      duringPersistBeforeInsert = null;
      live.dispose();
    }
  });

  test("a keep is refused by a replacement that lands between insert attempts", async () => {
    // Contention retries the insert after an awaited backoff, so an answer
    // given once for the call speaks only for the first attempt. A delete and
    // recreate inside that sleep leaves the retry writing into a row the frame
    // was never accepted for.
    const live = liveConversation("Live voice keep replaced between attempts");
    try {
      const frame = await uploadFrame("between-attempts.png");

      beforeFailingInsertAttempt = () => {
        deleteConversationRows(live.id);
        createConversation({ id: live.id, title: "Recreated" });
      };

      expect(await persistAmbientSightFrame(live.id, frame, "voice")).toEqual({
        ok: false,
      });

      expect(getMessages(live.id)).toHaveLength(0);
      expect(frameStored(frame)).toBe(false);
    } finally {
      beforeFailingInsertAttempt = null;
      live.dispose();
    }
  });

  test("a keep whose first insert attempt hit contention still lands", async () => {
    // The control on the check above: a retry the conversation outlived is the
    // ordinary path `withSqliteRetry` exists for, and the frame has to survive
    // it exactly as it always has.
    const live = liveConversation("Live voice keep retried insert");
    try {
      const frame = await uploadFrame("retried.png");

      beforeFailingInsertAttempt = () => {};

      const result = await persistAmbientSightFrame(live.id, frame, "voice");
      expect(result.ok).toBe(true);

      const rows = getMessages(live.id);
      expect(rows).toHaveLength(1);
      expect(result.messageId).toBe(rows[0].id);
      expect(frameStored(frame)).toBe(true);
    } finally {
      beforeFailingInsertAttempt = null;
      live.dispose();
    }
  });

  test("a frame refused under an unreadable store is collected once it answers", async () => {
    // `persisted: false` tells the client the daemon has dealt with the
    // upload, and nothing else ever collects an attachment no caller names:
    // collection is candidate-driven with no sweep. So a refusal the store
    // could not explain has to come back to the question rather than leave the
    // bytes for good.
    const live = liveConversation("Live voice keep unreadable store");
    const watch = watchEchoes(live.id);
    try {
      const frame = await uploadFrame("unreadable.png");

      storeUnreadable = true;
      const result = await persistAmbientSightFrame(live.id, frame, "voice");
      storeUnreadable = false;

      expect(result).toEqual({ ok: false });
      // Not reclaimed on the spot: "could not read" is not "no row".
      expect(frameStored(frame)).toBe(true);
      expect(_pendingFrameReclaimCountForTests()).toBe(1);

      _drainFrameReclaimRechecksForTests();

      expect(_pendingFrameReclaimCountForTests()).toBe(0);
      expect(frameStored(frame)).toBe(false);
      expect(getMessages(live.id)).toHaveLength(0);
      // No row landed, so there is nothing to tell the client about and the
      // refusal it already has stands.
      expect(watch.echoes()).toHaveLength(0);
    } finally {
      storeUnreadable = false;
      watch.dispose();
      live.dispose();
    }
  });

  test("a frame whose row landed is kept and announced when the store answers", async () => {
    // The other half of the same question. A persist can fail after its row
    // committed, and that row references the bytes through content the link
    // write never got to protect, so a recheck that finds the row must leave
    // the attachment alone. The client was told the frame was dropped, so
    // without the announce the row it never heard about waits for a reload.
    const live = liveConversation("Live voice keep row landed unreadable");
    const watch = watchEchoes(live.id);
    try {
      const frame = await uploadFrame("landed.png");

      breakStoreAfterInsert = true;
      const result = await persistAmbientSightFrame(live.id, frame, "voice");
      storeUnreadable = false;

      expect(result).toEqual({ ok: false });
      expect(_pendingFrameReclaimCountForTests()).toBe(1);

      _drainFrameReclaimRechecksForTests();

      expect(_pendingFrameReclaimCountForTests()).toBe(0);
      // The row is in the transcript, so its bytes are spoken for.
      const rows = getMessages(live.id);
      expect(rows).toHaveLength(1);
      expect(frameStored(frame)).toBe(true);

      await waitFor(() => watch.echoes().length > 0, {
        message: "Timed out waiting for the deferred row announcement",
      });
      expect(watch.echoes()).toMatchObject([
        {
          type: "user_message_echo",
          text: "(camera frame)",
          conversationId: live.id,
          messageId: rows[0].id,
        },
      ]);
    } finally {
      breakStoreAfterInsert = false;
      storeUnreadable = false;
      watch.dispose();
      live.dispose();
    }
  });

  test("a frame outlasting the quick passes waits, then settles when the store returns", async () => {
    // Ten passes was once the whole budget, and dropping a record there loses
    // its upload for good: nothing else in the daemon collects an attachment
    // no caller names. The passes only get further apart.
    const live = liveConversation("Live voice keep long outage");
    const watch = watchEchoes(live.id);
    try {
      const landed = await uploadFrame("outage-landed.png");
      const dropped = await uploadFrame("outage-dropped.png");

      // One frame whose row commits before the store goes, one that never
      // reaches an insert at all, so both branches wait out the same outage.
      breakStoreAfterInsert = true;
      expect(await persistAmbientSightFrame(live.id, landed, "voice")).toEqual({
        ok: false,
      });
      expect(await persistAmbientSightFrame(live.id, dropped, "voice")).toEqual(
        { ok: false },
      );

      expect(_pendingFrameReclaimCountForTests()).toBe(2);
      expect(_nextFrameReclaimRecheckDelayForTests()).toBe(30_000);

      // Well past the ten passes the records used to be given up at.
      for (let pass = 0; pass < 14; pass += 1) {
        _drainFrameReclaimRechecksForTests();
      }

      expect(_pendingFrameReclaimCountForTests()).toBe(2);
      // Asking less often rather than not at all.
      expect(_nextFrameReclaimRecheckDelayForTests()).toBe(300_000);

      // The store comes back long after the old cap.
      storeUnreadable = false;
      // Neither upload was given up while it was down.
      expect(frameStored(landed)).toBe(true);
      expect(frameStored(dropped)).toBe(true);

      _drainFrameReclaimRechecksForTests();

      expect(_pendingFrameReclaimCountForTests()).toBe(0);
      expect(frameStored(landed)).toBe(true);
      expect(frameStored(dropped)).toBe(false);

      const rows = getMessages(live.id);
      expect(rows).toHaveLength(1);
      await waitFor(() => watch.echoes().length > 0, {
        message: "Timed out waiting for the post-outage row announcement",
      });
      expect(watch.echoes()).toMatchObject([
        { type: "user_message_echo", messageId: rows[0].id },
      ]);
    } finally {
      breakStoreAfterInsert = false;
      storeUnreadable = false;
      watch.dispose();
      live.dispose();
    }
  });

  test("the conversation's chain is dropped once it drains", async () => {
    const live = liveConversation("Live voice chain cleanup");
    try {
      const frame = await uploadFrame("cleanup.png");

      const pending = persistAmbientSightFrame(live.id, frame, "voice");
      expect(_standaloneImageQueueSizeForTests()).toBe(1);
      expect(await pending).toMatchObject({ ok: true });

      // Nothing is left behind for a call that ended.
      expect(_standaloneImageQueueSizeForTests()).toBe(0);
    } finally {
      live.dispose();
    }
  });
});

describe("pendingStandaloneImagePersist", () => {
  test("reports nothing for a conversation with no image queued", async () => {
    const live = liveConversation("Sight pending idle");
    try {
      expect(pendingStandaloneImagePersist(live.id)).toBeNull();
    } finally {
      live.dispose();
    }
  });

  test("reports a keep from the tick it was handed in", async () => {
    // The count is taken before the persist's first await, which is what lets
    // a turn launching in the same call chain as the utterance see a frame
    // that has not started writing.
    const live = liveConversation("Sight pending keep");
    try {
      const frame = await uploadFrame("pending-keep.png");

      const keep = persistAmbientSightFrame(live.id, frame, "voice");
      const pending = pendingStandaloneImagePersist(live.id);
      expect(pending).not.toBeNull();
      expect(getMessages(live.id)).toHaveLength(0);

      await pending;

      // Settled means written and the flag handed back, so a turn waiting on
      // this both sees the row and can claim the flag.
      expect(getMessages(live.id)).toHaveLength(1);
      expect(live.activeConversation.isProcessing()).toBe(false);
      expect(await keep).toMatchObject({ ok: true });
      expect(pendingStandaloneImagePersist(live.id)).toBeNull();
    } finally {
      live.dispose();
    }
  });

  test("reports a photo in flight, not keeps alone", async () => {
    // A user who snaps a shutter photo and asks about it straight away wants
    // the same freshness, so the ledger this reads counts both kinds.
    const live = liveConversation("Sight pending photo");
    try {
      const photo = await uploadFrame("pending-photo.png");

      const snap = persistLiveVoicePhoto(live.id, photo);
      const pending = pendingStandaloneImagePersist(live.id);
      expect(pending).not.toBeNull();

      await pending;

      expect(getMessages(live.id)).toHaveLength(1);
      expect(await snap).toMatchObject({ ok: true });
    } finally {
      live.dispose();
    }
  });

  test("settles rather than rejects when the persist gives up", async () => {
    const live = liveConversation("Sight pending failure");
    try {
      const keep = persistAmbientSightFrame(live.id, "att-missing", "voice");
      const pending = pendingStandaloneImagePersist(live.id);
      expect(pending).not.toBeNull();

      expect(await pending).toBeUndefined();
      expect(await keep).toMatchObject({ ok: false });
      expect(getMessages(live.id)).toHaveLength(0);
    } finally {
      live.dispose();
    }
  });

  test("covers what was queued when it was asked, not what arrives after", async () => {
    // The boundary a caller can rely on: a frame the client sends during the
    // wait belongs to whatever asks next, so the wait stays bounded by work
    // that was already in flight.
    const live = liveConversation("Sight pending boundary");
    try {
      const first = await uploadFrame("boundary-first.png");
      const second = await uploadFrame("boundary-second.png");

      live.activeConversation.setProcessing(true);
      const firstKeep = persistAmbientSightFrame(live.id, first, "voice");
      // Long enough for the first keep to reach the idle wait, so the second
      // queues behind a job that has already begun rather than replacing it.
      await sleep(30);
      const pending = pendingStandaloneImagePersist(live.id);
      const secondKeep = persistAmbientSightFrame(live.id, second, "voice");
      live.activeConversation.setProcessing(false);

      await pending;
      expect(getMessages(live.id)).toHaveLength(1);

      expect(await firstKeep).toMatchObject({ ok: true });
      expect(await secondKeep).toMatchObject({ ok: true });
      expect(getMessages(live.id)).toHaveLength(2);
    } finally {
      live.dispose();
    }
  });
});
