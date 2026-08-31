import { describe, expect, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";
import { waitFor } from "../../__tests__/helpers/wait-for.js";

setConfig("memory", { enabled: false });

import type { AssistantEvent } from "../../api/index.js";
import { Conversation } from "../../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../../daemon/conversation-registry.js";
import { applySightFrameRetention } from "../../daemon/conversation-runtime-assembly.js";
import {
  getAttachmentById,
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../../persistence/attachments-store.js";
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
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import {
  _setProcessingWaitMsForTests,
  _standaloneImageQueueSizeForTests,
  persistLiveVoicePhoto,
  persistLiveVoiceSightFrame,
} from "../live-voice-photo.js";

await initializeDb();

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
  const original = conversation.setProcessing.bind(conversation);
  conversation.setProcessing = (value: boolean): void => {
    seen.calls.push(value);
    seen.depth += value ? 1 : -1;
    seen.maxDepth = Math.max(seen.maxDepth, seen.depth);
    original(value);
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
 * Let a turn try to start in the instant right after the persist reads the
 * flag free. The turn models a correct acquirer: it claims only what it finds
 * free, so it succeeds exactly when the persist left a gap between its read
 * and its take.
 */
function armTurnStartInTheGap(conversation: Conversation): {
  claimed: () => boolean;
} {
  let armed = true;
  let claimed = false;
  const readFlag = conversation.isProcessing.bind(conversation);
  const writeFlag = conversation.setProcessing.bind(conversation);
  conversation.isProcessing = (): boolean => {
    const busy = readFlag();
    if (armed && !busy) {
      armed = false;
      queueMicrotask(() => {
        if (!readFlag()) {
          writeFlag(true);
          claimed = true;
        }
      });
    }
    return busy;
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

describe("persistLiveVoiceSightFrame", () => {
  test("tags the row with the attachment it carries", async () => {
    const live = liveConversation("Live voice sight frame");
    try {
      const attachment = await uploadAttachment(
        "frame.png",
        "image/png",
        IMAGE_BASE64,
      );

      const result = await persistLiveVoiceSightFrame(live.id, attachment.id);
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
        (await persistLiveVoiceSightFrame(live.id, attachment.id)).ok,
      ).toBe(true);

      expect(metadataOf(getMessages(live.id)[0]).scripted).toBe(true);
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

      expect((await persistLiveVoiceSightFrame(live.id, arrivedAs)).ok).toBe(
        true,
      );

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

      expect((await persistLiveVoiceSightFrame(live.id, arrivedAs)).ok).toBe(
        true,
      );

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
      expect((await persistLiveVoiceSightFrame(live.id, arrivedAs)).ok).toBe(
        true,
      );
      for (const name of ["live-fresh-a.png", "live-fresh-b.png"]) {
        const fresh = await uploadFrame(name);
        expect((await persistLiveVoiceSightFrame(live.id, fresh)).ok).toBe(
          true,
        );
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
      expect((await persistLiveVoiceSightFrame(live.id, arrivedAs)).ok).toBe(
        true,
      );
      for (const name of ["later-a.png", "later-b.png"]) {
        const fresh = await uploadAttachment(name, "image/png", IMAGE_BASE64);
        expect((await persistLiveVoiceSightFrame(live.id, fresh.id)).ok).toBe(
          true,
        );
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
      expect(await persistLiveVoiceSightFrame(live.id, "att-missing")).toEqual({
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
      const pending = persistLiveVoiceSightFrame(live.id, attachment.id);
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
      const frameWrite = persistLiveVoiceSightFrame(live.id, frame);

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
      const firstKeep = persistLiveVoiceSightFrame(live.id, first);
      // Long enough for the first keep to reach the idle wait, so the second
      // queues behind a job that has already begun rather than replacing it.
      await sleep(30);
      const secondKeep = persistLiveVoiceSightFrame(live.id, second);
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
      const keep = persistLiveVoiceSightFrame(live.id, frame);
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
      const runningKeep = persistLiveVoiceSightFrame(live.id, running);
      await sleep(30);
      const staleKeep = persistLiveVoiceSightFrame(live.id, stale);
      const newestKeep = persistLiveVoiceSightFrame(live.id, newest);
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
      expect(await persistLiveVoiceSightFrame(live.id, frame)).toEqual({
        ok: false,
      });

      expect(frameStored(frame)).toBe(false);
      expect(getMessages(live.id)).toHaveLength(0);
    } finally {
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

  test("the conversation's chain is dropped once it drains", async () => {
    const live = liveConversation("Live voice chain cleanup");
    try {
      const frame = await uploadFrame("cleanup.png");

      const pending = persistLiveVoiceSightFrame(live.id, frame);
      expect(_standaloneImageQueueSizeForTests()).toBe(1);
      expect(await pending).toMatchObject({ ok: true });

      // Nothing is left behind for a call that ended.
      expect(_standaloneImageQueueSizeForTests()).toBe(0);
    } finally {
      live.dispose();
    }
  });
});
