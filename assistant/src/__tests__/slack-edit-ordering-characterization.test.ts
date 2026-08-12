/**
 * Characterization: Slack edits are applied in ARRIVAL order with no
 * comparison against the edit's Slack `edited.ts`. Two distinct edits
 * delivered out of order therefore leave the OLDER text persisted. This is
 * a pre-existing gap; it becomes load-bearing for LUM-3023 because mention
 * source data must be replaced atomically with content, so a stale edit
 * that wins would also resurrect stale mention data.
 *
 * The first test pins today's behavior so the future guard's PR flips it
 * consciously; the `test.todo` entries specify the intended semantics.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });

import {
  addMessage,
  getMessageById,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { linkMessage, recordInbound } from "../persistence/delivery-crud.js";
import { stringifyMessageContent } from "../persistence/message-content.js";
import { handleEditIntercept } from "../runtime/routes/inbound-stages/edit-intercept.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
}

const CHANNEL = "C0123CHANNEL";
const ORIGINAL_TS = "1700000000.000100";

async function seedMessage(): Promise<string> {
  const inbound = recordInbound("slack", CHANNEL, ORIGINAL_TS, {
    sourceMessageId: ORIGINAL_TS,
  });
  const inserted = await addMessage(
    inbound.conversationId,
    "user",
    JSON.stringify([{ type: "text", text: "original text" }]),
    { metadata: { userMessageChannel: "slack" }, skipIndexing: true },
  );
  linkMessage(inbound.eventId, inserted.id);
  return inserted.id;
}

async function applyEdit(eventId: string, content: string): Promise<void> {
  await handleEditIntercept({
    sourceChannel: "slack",
    conversationExternalId: CHANNEL,
    externalMessageId: eventId,
    sourceMessageId: ORIGINAL_TS,
    assistantId: "self",
    content,
  });
}

describe("Slack edit ordering (characterization)", () => {
  beforeEach(resetTables);

  test("CURRENT BEHAVIOR: a later-arriving older edit overwrites the newer text", async () => {
    const messageId = await seedMessage();

    // The user's second (newer) edit arrives first…
    await applyEdit("edit-event-newer", "second revision");
    // …then the first (older) edit arrives late and wins by arrival order.
    await applyEdit("edit-event-older", "first revision");

    const row = getMessageById(messageId);
    expect(stringifyMessageContent(row!.content)).toBe("first revision");
  });

  test("duplicate delivery of the same edit event is a no-op", async () => {
    const messageId = await seedMessage();

    await applyEdit("edit-event-dup", "revised text");
    // Same eventId again: recordInbound dedups it before any content write.
    await applyEdit("edit-event-dup", "should never apply");

    const row = getMessageById(messageId);
    expect(stringifyMessageContent(row!.content)).toBe("revised text");
  });

  test.todo(
    "GUARD (future PR): an edit whose Slack edited.ts is older than the stored one is ignored",
    () => {},
  );

  test.todo(
    "GUARD (future PR): content and mention source data are replaced in the same transaction on every applied edit",
    () => {},
  );
});
