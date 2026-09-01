/**
 * Tests for POST /v1/conversations/:id/sight-frame, the HTTP door the text
 * chat's camera tile persists a kept frame through.
 *
 * Exercises the guards the handler owns (an id that names no conversation, a
 * body with no attachment) and the persist behaviour it inherits from the
 * live-voice path, including the one difference: a keep taken beside the
 * composer is not a voice session turn.
 */

import { describe, expect, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../../__tests__/helpers/set-config.js";

setConfig("memory", { enabled: false });

import { Conversation } from "../../../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../../../daemon/conversation-registry.js";
import { _setProcessingWaitMsForTests } from "../../../live-voice/live-voice-photo.js";
import {
  getAttachmentById,
  uploadAttachment,
} from "../../../persistence/attachments-store.js";
import {
  createConversation,
  getMessages,
  type MessageRow,
} from "../../../persistence/conversation-crud.js";
import { sightFrameAttachmentIdsFromMetadata } from "../../../persistence/conversation-types.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { conversations } from "../../../persistence/schema/index.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { ROUTES as SIGHT_FRAME_ROUTES } from "../sight-frame-routes.js";
import type { RouteDefinition } from "../types.js";

await initializeDb();

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const sightFrameHandler = findHandler(
  SIGHT_FRAME_ROUTES,
  "conversationSightFrame",
);

interface SightFrameResponse {
  persisted: boolean;
  messageId?: string;
}

function persist(
  id: string,
  body: Record<string, unknown>,
): Promise<SightFrameResponse> {
  return sightFrameHandler({
    pathParams: { id },
    body,
  }) as Promise<SightFrameResponse>;
}

/** A registered conversation the persist path can reach, plus its teardown. */
function liveConversation(title: string) {
  const row = createConversation(title);
  const { provider } = createMockProvider([textResponse("")]);
  const activeConversation = new Conversation(
    row.id,
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
  setConversation(row.id, activeConversation);
  return {
    id: row.id,
    activeConversation,
    dispose: () => {
      deleteConversation(row.id);
      activeConversation.dispose();
    },
  };
}

function metadataOf(row: MessageRow): Record<string, unknown> {
  return JSON.parse(row.metadata ?? "{}") as Record<string, unknown>;
}

function conversationCount(): number {
  return getDb().select({ id: conversations.id }).from(conversations).all()
    .length;
}

function uploadFrame(name: string): Promise<string> {
  return uploadAttachment(name, "image/png", IMAGE_BASE64).then((a) => a.id);
}

/** True while the attachment's row is still in the store. */
function frameStored(attachmentId: string): boolean {
  return getAttachmentById(attachmentId) !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("POST /v1/conversations/:id/sight-frame", () => {
  test("404s for an unknown id without minting a conversation for it", async () => {
    // The persist calls `getOrCreateConversation`, so an id the handler lets
    // through becomes a conversation holding nothing but camera frames.
    const before = conversationCount();

    await expect(
      persist(crypto.randomUUID(), { attachmentId: "att-1" }),
    ).rejects.toThrow(NotFoundError);

    expect(conversationCount()).toBe(before);
  });

  test("400s when the body carries no attachment", async () => {
    const live = liveConversation("Chat keep bad body");
    try {
      await expect(persist(live.id, {})).rejects.toThrow(BadRequestError);
      await expect(persist(live.id, { attachmentId: "" })).rejects.toThrow(
        BadRequestError,
      );
      await expect(persist(live.id, { attachmentId: 7 })).rejects.toThrow(
        BadRequestError,
      );
      expect(getMessages(live.id)).toHaveLength(0);
    } finally {
      live.dispose();
    }
  });

  test("persists the frame as its own tagged row and names it", async () => {
    const live = liveConversation("Chat keep happy path");
    try {
      const attachmentId = await uploadFrame("frame.png");

      const response = await persist(live.id, { attachmentId });

      const [row] = getMessages(live.id);
      expect(response).toEqual({ persisted: true, messageId: row.id });
      expect(row.content.filter((block) => block.type === "text")).toEqual([
        { type: "text", text: "(camera frame)" },
      ]);
      // Retention reads the tag and the memory-privacy guard reads the pair of
      // `scripted` and the tag, so a chat keep has to carry both.
      expect(metadataOf(row).scripted).toBe(true);
      expect(sightFrameAttachmentIdsFromMetadata(metadataOf(row))).toEqual([
        attachmentId,
      ]);
    } finally {
      live.dispose();
    }
  });

  test("does not mark a composer keep as a voice session turn", async () => {
    // The mark says a reply reaches the user over a session that is still
    // open. Nothing is open here, so a reply that follows this row has to be
    // pushed like any other.
    const live = liveConversation("Chat keep voice mark");
    try {
      const attachmentId = await uploadFrame("frame.png");

      expect(await persist(live.id, { attachmentId })).toMatchObject({
        persisted: true,
      });

      expect(
        metadataOf(getMessages(live.id)[0]).voiceSessionTurn,
      ).toBeUndefined();
    } finally {
      live.dispose();
    }
  });

  test("reports a frame whose attachment does not resolve", async () => {
    const live = liveConversation("Chat keep missing attachment");
    try {
      expect(await persist(live.id, { attachmentId: "att-missing" })).toEqual({
        persisted: false,
      });
      expect(getMessages(live.id)).toHaveLength(0);
    } finally {
      live.dispose();
    }
  });

  test("two overlapping keeps write one at a time", async () => {
    // The processing flag is a boolean rather than a counted lock, so two
    // persists in flight at once would both read it free and both take it.
    const live = liveConversation("Chat keep serialized");
    try {
      const first = await uploadFrame("first.png");
      const second = await uploadFrame("second.png");

      live.activeConversation.setProcessing(true);
      const firstKeep = persist(live.id, { attachmentId: first });
      // Long enough for the first keep to reach the idle wait, so the second
      // queues behind a job that has already begun rather than replacing it.
      await sleep(30);
      const secondKeep = persist(live.id, { attachmentId: second });
      await sleep(30);
      live.activeConversation.setProcessing(false);

      expect(await firstKeep).toMatchObject({ persisted: true });
      expect(await secondKeep).toMatchObject({ persisted: true });
      expect(getMessages(live.id)).toHaveLength(2);
    } finally {
      live.dispose();
    }
  });

  test("a newer keep replaces one still waiting, and its upload is reclaimed", async () => {
    // What bounds the chain: keeps arrive every few seconds while each job can
    // wait out a turn for far longer. The displaced upload is the daemon's to
    // collect, because the client's own abandon-delete fires on a refused
    // send and this send was accepted.
    const live = liveConversation("Chat keep superseded");
    try {
      const running = await uploadFrame("running.png");
      const stale = await uploadFrame("stale.png");
      const newest = await uploadFrame("newest.png");

      live.activeConversation.setProcessing(true);
      const runningKeep = persist(live.id, { attachmentId: running });
      await sleep(30);
      const staleKeep = persist(live.id, { attachmentId: stale });
      const newestKeep = persist(live.id, { attachmentId: newest });
      await sleep(30);
      live.activeConversation.setProcessing(false);

      expect(await runningKeep).toMatchObject({ persisted: true });
      expect(await staleKeep).toEqual({ persisted: false });
      expect(await newestKeep).toMatchObject({ persisted: true });

      expect(getMessages(live.id)).toHaveLength(2);
      expect(frameStored(stale)).toBe(false);
      expect(frameStored(running)).toBe(true);
      expect(frameStored(newest)).toBe(true);
    } finally {
      live.dispose();
    }
  });

  test("reports a keep that outwaited the turn ahead of it", async () => {
    const restoreWait = _setProcessingWaitMsForTests(120);
    const live = liveConversation("Chat keep wait timeout");
    try {
      const frame = await uploadFrame("timed-out.png");

      live.activeConversation.setProcessing(true);
      expect(await persist(live.id, { attachmentId: frame })).toEqual({
        persisted: false,
      });

      expect(frameStored(frame)).toBe(false);
      expect(getMessages(live.id)).toHaveLength(0);
    } finally {
      live.activeConversation.setProcessing(false);
      live.dispose();
      _setProcessingWaitMsForTests(restoreWait);
    }
  });
});
