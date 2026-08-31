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
