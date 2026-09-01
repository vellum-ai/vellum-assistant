/**
 * Tests for POST /v1/conversations/:id/sight-frame, the HTTP door the text
 * chat's camera tile persists a kept frame through.
 *
 * Exercises the guards the handler owns (an id that names no conversation, a
 * body with no attachment), the actor the row is attributed to, and the
 * persist behaviour it inherits from the live-voice path, including the one
 * difference: a keep taken beside the composer is not a voice session turn.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";

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
import { destroyActiveConversation } from "../../../daemon/conversation-store.js";
import { _setProcessingWaitMsForTests } from "../../../live-voice/live-voice-photo.js";
import {
  getAttachmentById,
  uploadAttachment,
} from "../../../persistence/attachments-store.js";
import {
  createConversation,
  deleteConversation as deleteConversationRows,
  getConversation,
  getMessages,
  type MessageRow,
} from "../../../persistence/conversation-crud.js";
import { sightFrameAttachmentIdsFromMetadata } from "../../../persistence/conversation-types.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { conversations } from "../../../persistence/schema/index.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { RouteDefinition } from "../types.js";
import * as vellumActorTrust from "../vellum-actor-trust.js";

/**
 * Run something in the window the handler opens between accepting the request
 * and persisting the frame.
 *
 * Resolving the request's actor is the only thing the handler awaits in
 * between, so a hook here lands inside that window without a timer to race.
 * Armed per test and cleared as it fires; every other test leaves it null and
 * gets the real resolver.
 */
let duringTrustResolution: (() => void) | null = null;
const realVellumActorTrust = { ...vellumActorTrust };
mock.module("../vellum-actor-trust.js", () => ({
  ...realVellumActorTrust,
  resolveVellumActorTrustContext: (
    ...args: Parameters<
      typeof realVellumActorTrust.resolveVellumActorTrustContext
    >
  ) => {
    const hook = duringTrustResolution;
    duringTrustResolution = null;
    hook?.();
    return realVellumActorTrust.resolveVellumActorTrustContext(...args);
  },
}));

const { ROUTES: SIGHT_FRAME_ROUTES } = await import("../sight-frame-routes.js");

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
  headers?: Record<string, string>,
): Promise<SightFrameResponse> {
  return sightFrameHandler({
    pathParams: { id },
    body,
    ...(headers ? { headers } : {}),
  }) as Promise<SightFrameResponse>;
}

/** Tear the conversation down the way DELETE /v1/conversations/:id does. */
function deleteEverywhere(id: string): void {
  destroyActiveConversation(id, { keepSubagentRecords: true });
  deleteConversationRows(id);
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

  test("attributes the row to the verified actor, not the conversation's trust", async () => {
    // The conversation rests on the trust of whoever used it last, so a row
    // stamped from the slot names that actor rather than the one this request
    // was verified as. Actor-scoped history reads the stamp, so the wrong one
    // either hides the frame from its owner or lends guardian standing to
    // content that has none.
    const live = liveConversation("Chat keep actor attribution");
    try {
      const attachmentId = await uploadFrame("frame.png");
      // A principal no guardian binding names, which the vellum-channel
      // resolver fails closed to `unknown`.
      const headers = { "x-vellum-actor-principal-id": "actor-not-bound" };
      expect(live.activeConversation.trustContext?.trustClass).toBe("guardian");

      expect(await persist(live.id, { attachmentId }, headers)).toMatchObject({
        persisted: true,
      });

      const metadata = metadataOf(getMessages(live.id)[0]);
      expect(metadata.provenanceTrustClass).toBe("unknown");
      expect(metadata.provenanceSourceChannel).toBe("vellum");
    } finally {
      live.dispose();
    }
  });

  test("attributes a caller with no actor header to the guardian", async () => {
    // A local or IPC caller carries no actor header and is the guardian by
    // construction, the same reading canonical ingress gives it.
    const live = liveConversation("Chat keep local caller");
    try {
      const attachmentId = await uploadFrame("frame.png");

      expect(await persist(live.id, { attachmentId })).toMatchObject({
        persisted: true,
      });

      const metadata = metadataOf(getMessages(live.id)[0]);
      expect(metadata.provenanceTrustClass).toBe("guardian");
      expect(metadata.provenanceSourceChannel).toBe("vellum");
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

  test("a frame from another actor makes the resident history reload", async () => {
    // The persist stamps the ROW for the actor that sent it, but the message
    // it appends to the resident history carries no scope of its own. A
    // conversation resident under one actor would go on sending that array to
    // the model, image included, while a reload would have filtered it out.
    const live = liveConversation("Chat keep cross trust");
    // Scope the resident history for the conversation's own actor.
    await live.activeConversation.ensureActorScopedHistory();
    const reload = spyOn(Conversation.prototype, "loadFromDb");
    try {
      const attachmentId = await uploadFrame("cross-trust.png");
      // A principal no guardian binding names, which the vellum-channel
      // resolver fails closed to `unknown`: not the class this history holds.
      expect(
        await persist(
          live.id,
          { attachmentId },
          { "x-vellum-actor-principal-id": "actor-not-bound" },
        ),
      ).toMatchObject({ persisted: true });

      await live.activeConversation.ensureActorScopedHistory();

      // Reloaded and re-filtered rather than reusing the array the frame was
      // appended to.
      expect(reload).toHaveBeenCalled();
    } finally {
      reload.mockRestore();
      live.dispose();
    }
  });

  test("a frame from the resident actor does not force a reload", async () => {
    // The control on the check above. Frames arrive on a camera's cadence, so
    // a reload apiece is a real cost and only a differing scope earns one.
    const live = liveConversation("Chat keep same trust");
    await live.activeConversation.ensureActorScopedHistory();
    const reload = spyOn(Conversation.prototype, "loadFromDb");
    try {
      const attachmentId = await uploadFrame("same-trust.png");
      // No actor header, which the resolver reads as the guardian: the class
      // the resident history is already scoped for.
      expect(await persist(live.id, { attachmentId })).toMatchObject({
        persisted: true,
      });

      await live.activeConversation.ensureActorScopedHistory();

      expect(reload).not.toHaveBeenCalled();
    } finally {
      reload.mockRestore();
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

  test("a deletion is final for a keep still queued behind another", async () => {
    // The route's 404 speaks only for the moment it ran. A keep queued behind
    // another one starts later, so the job re-reads the conversation before it
    // touches anything: the persist reaches it through
    // `getOrCreateConversation`, which writes the row back for an id it finds
    // missing, and a deleted conversation must not return carrying nothing but
    // camera frames.
    const restoreWait = _setProcessingWaitMsForTests(150);
    const live = liveConversation("Chat keep deleted mid-queue");
    const holder = await uploadFrame("holder.png");
    const queued = await uploadFrame("queued.png");
    try {
      // The first keep holds the chain by waiting out a turn that never ends,
      // so the second is still queued and has touched nothing.
      live.activeConversation.setProcessing(true);
      const holderKeep = persist(live.id, { attachmentId: holder });
      await sleep(30);
      const queuedKeep = persist(live.id, { attachmentId: queued });

      deleteEverywhere(live.id);
      const countAfterDelete = conversationCount();

      expect(await holderKeep).toEqual({ persisted: false });
      expect(await queuedKeep).toEqual({ persisted: false });

      expect(getConversation(live.id)).toBeNull();
      expect(conversationCount()).toBe(countAfterDelete);
      expect(getMessages(live.id)).toHaveLength(0);
      expect(frameStored(queued)).toBe(false);
    } finally {
      _setProcessingWaitMsForTests(restoreWait);
    }
  });

  test("a frame does not land in a conversation replaced while the actor resolves", async () => {
    // The 404 gate is where the frame is accepted, and resolving the request's
    // actor is awaited after it. A delete and recreate under this id inside
    // that await leaves a row the gate never saw, and a persist that read the
    // id for itself afterwards would take the replacement for the conversation
    // the client addressed.
    const live = liveConversation("Chat keep replaced mid-trust");
    try {
      const frame = await uploadFrame("mid-trust.png");

      duringTrustResolution = () => {
        deleteConversationRows(live.id);
        createConversation({ id: live.id, title: "Recreated" });
      };

      expect(await persist(live.id, { attachmentId: frame })).toEqual({
        persisted: false,
      });

      expect(getMessages(live.id)).toHaveLength(0);
      // Nothing else would ever collect it: the client's abandon-delete fires
      // on a refused send, and this send was accepted.
      expect(frameStored(frame)).toBe(false);
    } finally {
      duringTrustResolution = null;
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
