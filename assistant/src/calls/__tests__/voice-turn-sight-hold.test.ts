/**
 * The bounded wait a launching voice turn takes for a standalone image the
 * daemon already has in flight.
 *
 * The frames this is about arrive on the live-voice socket a beat before the
 * user stops speaking, and are counted the tick that message is handled while
 * their row is still several awaits away. A turn that launches in between
 * snapshots a history without the picture, and the answer describes the scene
 * before this one.
 *
 * Every case here parks the image's persist on a gate so the race is settled
 * by the code under test rather than by microtask order: the frame is queued,
 * holding nothing, exactly as it is when an utterance ends on top of it.
 */
import { describe, expect, mock, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";

setConfig("memory", { enabled: false, v2: { enabled: false } });
setConfig("secretDetection", { enabled: false });
setConfig("calls", { disclosure: { enabled: false, text: "" } });
setConfig("workspaceGit", { turnCommitMaxWaitMs: 100 });

import * as realConversationStore from "../../daemon/conversation-store.js";

/**
 * Gates the queued images take in the order they were enqueued, one each.
 * `getConversationIfExists` is the first thing a standalone persist awaits and
 * sits before its acquire, so a gate here parks a job that has been counted
 * but holds no flag.
 */
const frameGates: Array<Promise<void>> = [];

// Read out before the module is replaced: `mock.module` rebinds the namespace
// itself, so calling through it below would call the gate again.
const realStoreExports = { ...realConversationStore };

const gatedGetConversationIfExists: typeof realConversationStore.getConversationIfExists =
  async (conversationId, options) => {
    const gate = frameGates.shift();
    if (gate) {
      await gate;
    }
    return realStoreExports.getConversationIfExists(conversationId, options);
  };

mock.module("../../daemon/conversation-store.js", () => ({
  ...realStoreExports,
  getConversationIfExists: gatedGetConversationIfExists,
}));

import { Conversation } from "../../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../../daemon/conversation-registry.js";
import {
  pendingStandaloneImagePersist,
  persistAmbientSightFrame,
  persistLiveVoicePhoto,
  SIGHT_FRAME_TURN_HOLD_MS,
} from "../../live-voice/live-voice-photo.js";
import { uploadAttachment } from "../../persistence/attachments-store.js";
import {
  createConversation,
  getMessages,
  type MessageRow,
} from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import { startVoiceTurn } from "../voice-session-bridge.js";

await initializeDb();

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

const SPOKEN_CONTENT = "what am I looking at now?";
const FRAME_CONTENT = "(camera frame)";
const PHOTO_CONTENT = "here's a photo:";

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadFrame(name: string): Promise<string> {
  const attachment = await uploadAttachment(name, "image/png", IMAGE_BASE64);
  return attachment.id;
}

/** The row's own text, which is what names the row in an ordering assertion. */
function rowText(row: MessageRow): string {
  for (const block of row.content) {
    if (block.type === "text") {
      return block.text;
    }
  }
  return "";
}

function rowTexts(conversationId: string): string[] {
  return getMessages(conversationId).map(rowText);
}

/**
 * A registered conversation the bridge and the persist paths both reach.
 *
 * The agent loop is stubbed down to the one thing the rest of the turn depends
 * on, giving the hold back, so a suite about launch ordering does not run a
 * model.
 */
function liveConversation(title: string) {
  const row = createConversation(title);
  const { provider } = createMockProvider([textResponse("")]);
  const conversation = new Conversation(
    row.id,
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  conversation.setTrustContext({
    trustClass: "guardian",
    sourceChannel: "vellum",
  });
  conversation.runAgentLoop = async () => {
    conversation.setProcessing(false);
  };
  setConversation(row.id, conversation);
  return {
    id: row.id,
    conversation,
    dispose: () => {
      frameGates.length = 0;
      deleteConversation(row.id);
      conversation.dispose();
    },
  };
}

async function launchTurn(conversationId: string): Promise<void> {
  await startVoiceTurn({
    conversationId,
    content: SPOKEN_CONTENT,
    isInbound: false,
    onTextDelta: () => {},
    onComplete: () => {},
    onError: () => {},
  });
  // The agent loop is dispatched fire-and-forget; let it give the hold back
  // before the next assertion reads the conversation.
  await sleep(20);
}

describe("voice turn hold for an in-flight camera frame", () => {
  test("a frame queued before the launch lands ahead of the spoken row", async () => {
    const live = liveConversation("Sight hold ordering");
    const gate = deferred();
    try {
      const frame = await uploadFrame("hold-ordering.png");
      frameGates.push(gate.promise);

      const keep = persistAmbientSightFrame(live.id, frame, "voice");
      // Queued and counted, holding nothing: the state a turn launching on
      // the same utterance finds.
      expect(pendingStandaloneImagePersist(live.id)).not.toBeNull();
      expect(live.conversation.isProcessing()).toBe(false);

      const turn = launchTurn(live.id);
      await sleep(20);
      // The turn is waiting rather than persisting, so the frame still has a
      // free flag to take.
      expect(rowTexts(live.id)).toEqual([]);

      gate.open();
      expect(await keep).toMatchObject({ ok: true });
      await turn;

      expect(rowTexts(live.id)).toEqual([FRAME_CONTENT, SPOKEN_CONTENT]);
    } finally {
      gate.open();
      live.dispose();
    }
  });

  test("a photo queued before the launch holds the turn too", async () => {
    // The ledger counts every standalone image on purpose: a user who snaps a
    // photo and asks about it straight away wants the same freshness.
    const live = liveConversation("Sight hold photo");
    const gate = deferred();
    try {
      const photo = await uploadFrame("hold-photo.png");
      frameGates.push(gate.promise);

      const snap = persistLiveVoicePhoto(live.id, photo);
      const turn = launchTurn(live.id);
      await sleep(20);
      expect(rowTexts(live.id)).toEqual([]);

      gate.open();
      await snap;
      await turn;

      expect(rowTexts(live.id)).toEqual([PHOTO_CONTENT, SPOKEN_CONTENT]);
    } finally {
      gate.open();
      live.dispose();
    }
  });

  test("a stalled persist caps the hold and the turn goes on without it", async () => {
    const live = liveConversation("Sight hold cap");
    const gate = deferred();
    try {
      const frame = await uploadFrame("hold-cap.png");
      frameGates.push(gate.promise);

      const keep = persistAmbientSightFrame(live.id, frame, "voice");
      const startedAt = Date.now();
      await launchTurn(live.id);
      const elapsed = Date.now() - startedAt;

      // Waited the cap, then dispatched: the worst case is the answer this
      // turn would have given with no hold at all.
      expect(elapsed).toBeGreaterThanOrEqual(SIGHT_FRAME_TURN_HOLD_MS - 50);
      expect(elapsed).toBeLessThan(SIGHT_FRAME_TURN_HOLD_MS * 4);
      expect(rowTexts(live.id)).toEqual([SPOKEN_CONTENT]);

      gate.open();
      await keep;
    } finally {
      gate.open();
      live.dispose();
    }
  });

  test("a conversation with nothing in flight is not held at all", async () => {
    const live = liveConversation("Sight hold idle");
    try {
      expect(pendingStandaloneImagePersist(live.id)).toBeNull();

      const startedAt = Date.now();
      await launchTurn(live.id);
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(SIGHT_FRAME_TURN_HOLD_MS / 2);
      expect(rowTexts(live.id)).toEqual([SPOKEN_CONTENT]);
    } finally {
      live.dispose();
    }
  });

  test("a frame arriving after the check rides the next turn", async () => {
    // The wait covers what was in flight when the turn asked. A keep the
    // client sends while the turn is already waiting is the next turn's to
    // wait for, which is what keeps the hold bounded by work already queued.
    const live = liveConversation("Sight hold boundary");
    const firstGate = deferred();
    const secondGate = deferred();
    try {
      const first = await uploadFrame("hold-boundary-first.png");
      const second = await uploadFrame("hold-boundary-second.png");
      frameGates.push(firstGate.promise, secondGate.promise);

      const firstKeep = persistAmbientSightFrame(live.id, first, "voice");
      const turn = launchTurn(live.id);
      await sleep(20);

      const secondKeep = persistAmbientSightFrame(live.id, second, "voice");
      firstGate.open();
      await firstKeep;
      await turn;

      expect(rowTexts(live.id)).toEqual([FRAME_CONTENT, SPOKEN_CONTENT]);

      secondGate.open();
      await secondKeep;
      expect(rowTexts(live.id)).toEqual([
        FRAME_CONTENT,
        SPOKEN_CONTENT,
        FRAME_CONTENT,
      ]);
    } finally {
      firstGate.open();
      secondGate.open();
      live.dispose();
    }
  });
});
