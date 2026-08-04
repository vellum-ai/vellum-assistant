/**
 * Tests for handleListMessages Slack rawText projection (LUM-3023).
 *
 * Rows whose `slackMeta` carries the verbatim Slack text (mention markup
 * intact) must re-render mention names at read time instead of serving the
 * name resolution that happened to succeed at ingress: an embedded pipe
 * label upgrades a baked `#unknown-channel` to the real name, a bare token
 * degrades to the id-carrying fallback, and rows without `rawText` are
 * served exactly as stored.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

// Keep the memory system off so addMessage skips indexing side effects.
setConfig("memory", { enabled: false });

import { writeSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

interface ProjectedMessage {
  id: string;
  role: string;
  textSegments?: string[];
}

async function listTexts(conversationId: string): Promise<Map<string, string>> {
  const response = (await handleListMessages({
    queryParams: { conversationId },
  })) as { messages: ProjectedMessage[] };
  return new Map(
    response.messages.map((m) => [m.id, (m.textSegments ?? []).join("\n")]),
  );
}

function slackUserMessageMetadata(overrides: {
  channelTs: string;
  rawText?: string;
  eventKind?: "message" | "reaction";
  deletedAt?: number;
}): Record<string, unknown> {
  return {
    slackMeta: writeSlackMetadata({
      source: "slack",
      channelId: "C0123CHANNEL",
      channelTs: overrides.channelTs,
      eventKind: overrides.eventKind ?? "message",
      ...(overrides.rawText ? { rawText: overrides.rawText } : {}),
      ...(overrides.deletedAt !== undefined
        ? { deletedAt: overrides.deletedAt }
        : {}),
    }),
  };
}

describe("handleListMessages Slack rawText projection", () => {
  beforeEach(resetTables);

  test("re-renders a baked #unknown-channel from the embedded pipe label", async () => {
    const conv = createConversation();
    // The incident shape: ingress rendering missed the channel name, so the
    // stored display copy carries the destroyed mention while rawText keeps
    // the pipe-form token with the real name.
    const row = await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "post this in #unknown-channel going forward" },
      ]),
      {
        metadata: slackUserMessageMetadata({
          channelTs: "1700000000.000100",
          rawText: "post this in <#C99XYZ|prod-models> going forward",
        }),
      },
    );

    const texts = await listTexts(conv.id);
    expect(texts.get(row.id)).toBe("post this in #prod-models going forward");
  });

  test("renders the id-carrying fallback for bare tokens no auth can resolve", async () => {
    const conv = createConversation();
    // No Slack credentials exist in the test environment, so label
    // resolution yields nothing and the renderer's fallback keeps the id.
    const row = await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "post this in #unknown-channel going forward" },
      ]),
      {
        metadata: slackUserMessageMetadata({
          channelTs: "1700000000.000200",
          rawText: "post this in <#C99XYZ> going forward",
        }),
      },
    );

    const texts = await listTexts(conv.id);
    expect(texts.get(row.id)).toBe(
      "post this in #unknown-channel (C99XYZ) going forward",
    );
  });

  test("serves rows without rawText exactly as stored", async () => {
    const conv = createConversation();
    const row = await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "post this in #unknown-channel going forward" },
      ]),
      {
        metadata: slackUserMessageMetadata({
          channelTs: "1700000000.000300",
        }),
      },
    );

    const texts = await listTexts(conv.id);
    expect(texts.get(row.id)).toBe(
      "post this in #unknown-channel going forward",
    );
  });

  test("ignores rawText on deleted rows", async () => {
    const conv = createConversation();
    const row = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "original words" }]),
      {
        metadata: slackUserMessageMetadata({
          channelTs: "1700000000.000400",
          rawText: "original words with <#C99XYZ|prod-models>",
          deletedAt: 1700000100_000,
        }),
      },
    );

    const texts = await listTexts(conv.id);
    expect(texts.get(row.id)).toBe("original words");
  });
});
