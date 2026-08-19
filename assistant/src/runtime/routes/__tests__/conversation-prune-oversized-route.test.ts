/**
 * Tests for the administrative recovery route behind
 * `assistant conversations prune-oversized <id> --yes`.
 *
 * The route exists for a conversation already holding a message over the
 * provider per-string limit: the whole history is resent every turn, so such a
 * row makes every later turn fail with `string_above_max_length` and there is
 * otherwise no supported way to trim it. Recovery therefore has to keep the
 * row (deleting it would orphan a paired `tool_use`) and keep the conversation.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  addMessage,
  createConversation,
  getConversation,
  getMessages,
} from "../../../persistence/conversation-crud.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import {
  MAX_PERSISTED_MESSAGE_BYTES,
  messageContentBytes,
} from "../../../persistence/message-content-cap.js";
import { PRUNED_MESSAGE_EXPORT_DIR } from "../../../persistence/message-content-prune.js";
import { messages } from "../../../persistence/schema/index.js";
import { getWorkspaceDir } from "../../../util/platform.js";
import { ROUTES } from "../conversation-cli-routes.js";

await initializeDb();

const pruneRoute = ROUTES.find(
  (r) => r.operationId === "conversation_prune_oversized_cli",
)!;

const CONFIRM = { "x-confirm-destructive": "prune-oversized-messages" };

/** The incident shape: a ~50 MB scanner result written whole into history. */
const FIFTY_MB = 50_000_000;

type PruneResult = {
  conversationId: string;
  maxBytes: number;
  scanned: number;
  pruned: {
    messageId: string;
    originalBytes: number;
    prunedBytes: number;
    exportPath?: string;
  }[];
};

/**
 * Seed a conversation holding one oversized message, writing the oversized row
 * with raw SQL so it lands the way a pre-cap install did: straight past the
 * persistence guard the prune command exists to clean up after.
 */
async function seedOversizedConversation(): Promise<{
  conversationId: string;
  oversizedId: string;
  content: string;
}> {
  const conversation = await createConversation({ title: "Offsets Scanner" });
  const small = await addMessage(
    conversation.id,
    "user",
    JSON.stringify([{ type: "text", text: "scan the offsets" }]),
  );
  const oversized = await addMessage(
    conversation.id,
    "user",
    JSON.stringify([
      { type: "tool_result", tool_use_id: "toolu_1", content: "placeholder" },
    ]),
  );
  const content = JSON.stringify([
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "S".repeat(FIFTY_MB),
    },
  ]);
  getDb()
    .update(messages)
    .set({ content })
    .where(eq(messages.id, oversized.id))
    .run();

  expect(small.id).not.toBe(oversized.id);
  return {
    conversationId: conversation.id,
    oversizedId: oversized.id,
    content,
  };
}

function storedContent(messageId: string): string {
  return getDb()
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()!.content;
}

describe("POST /v1/conversations/cli/prune-oversized", () => {
  test("refuses to run without the destructive confirmation header", async () => {
    /** Trimming a body is irreversible, so it takes an explicit confirmation. */

    // GIVEN a conversation holding a 50 MB message
    const { conversationId, oversizedId, content } =
      await seedOversizedConversation();

    // WHEN the route is called without the confirmation header
    const call = () => pruneRoute.handler({ body: { conversationId } });

    // THEN it rejects
    expect(call).toThrow(/X-Confirm-Destructive/);

    // AND the oversized body is untouched
    expect(storedContent(oversizedId)).toBe(content);
  });

  test("trims the oversized message in place and keeps the row and conversation", async () => {
    /**
     * Tests that a bricked conversation becomes sendable again: the oversized
     * body drops under the cap while the row, its tool pairing, and the sibling
     * messages all survive.
     */

    // GIVEN a conversation holding a 50 MB message alongside a small one
    const { conversationId, oversizedId } = await seedOversizedConversation();

    // WHEN it is pruned with confirmation
    const result = (await pruneRoute.handler({
      body: { conversationId },
      headers: CONFIRM,
    })) as PruneResult;

    // THEN exactly the oversized message is reported as trimmed
    expect(result.maxBytes).toBe(MAX_PERSISTED_MESSAGE_BYTES);
    expect(result.scanned).toBe(2);
    expect(result.pruned).toHaveLength(1);
    expect(result.pruned[0]!.messageId).toBe(oversizedId);
    expect(result.pruned[0]!.originalBytes).toBeGreaterThan(FIFTY_MB);
    expect(result.pruned[0]!.prunedBytes).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );

    // AND the stored row is under the cap and still a paired tool_result
    const stored = storedContent(oversizedId);
    expect(messageContentBytes(stored)).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );
    expect(JSON.parse(stored)).toMatchObject([
      { type: "tool_result", tool_use_id: "toolu_1" },
    ]);

    // AND the conversation and both of its messages survive
    expect(getConversation(conversationId)).not.toBeUndefined();
    expect(getMessages(conversationId)).toHaveLength(2);
  });

  test("exports each original body before trimming it", async () => {
    /** The trimmed bytes stay recoverable for inspection after the prune. */

    // GIVEN a conversation holding a 50 MB message
    const { conversationId, content } = await seedOversizedConversation();

    // WHEN it is pruned with export left at its default
    const result = (await pruneRoute.handler({
      body: { conversationId },
      headers: CONFIRM,
    })) as PruneResult;

    // THEN the export path is workspace-relative
    const exportPath = result.pruned[0]!.exportPath!;
    expect(exportPath.startsWith(`${PRUNED_MESSAGE_EXPORT_DIR}/`)).toBe(true);

    // AND it holds the untrimmed original
    expect(readFileSync(join(getWorkspaceDir(), exportPath), "utf8")).toBe(
      content,
    );
  });

  test("skips the export when the caller opts out", async () => {
    /** An operator who only wants the conversation usable can skip the copy. */

    // GIVEN a conversation holding a 50 MB message
    const { conversationId, oversizedId } = await seedOversizedConversation();

    // WHEN it is pruned with export disabled
    const result = (await pruneRoute.handler({
      body: { conversationId, export: false },
      headers: CONFIRM,
    })) as PruneResult;

    // THEN the message is still trimmed, with no export reported
    expect(result.pruned[0]!.exportPath).toBeUndefined();
    expect(messageContentBytes(storedContent(oversizedId))).toBeLessThanOrEqual(
      MAX_PERSISTED_MESSAGE_BYTES,
    );
  });

  test("reports nothing pruned for a conversation with no oversized message", async () => {
    /** A healthy conversation is scanned and left alone. */

    // GIVEN a conversation whose messages are all small
    const conversation = await createConversation({ title: "Healthy" });
    await addMessage(
      conversation.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
    );

    // WHEN it is pruned
    const result = (await pruneRoute.handler({
      body: { conversationId: conversation.id },
      headers: CONFIRM,
    })) as PruneResult;

    // THEN the message is counted as scanned and nothing is trimmed
    expect(result.scanned).toBe(1);
    expect(result.pruned).toEqual([]);
  });

  test("resolves a conversation id prefix like the neighboring CLI routes", async () => {
    /** Operators paste the short id the CLI prints, not the full uuid. */

    // GIVEN a conversation holding a 50 MB message
    const { conversationId, oversizedId } = await seedOversizedConversation();

    // WHEN it is pruned by id prefix
    const result = (await pruneRoute.handler({
      body: { conversationId: conversationId.slice(0, 8) },
      headers: CONFIRM,
    })) as PruneResult;

    // THEN the full conversation is resolved and pruned
    expect(result.conversationId).toBe(conversationId);
    expect(result.pruned[0]!.messageId).toBe(oversizedId);
  });

  test("rejects an unknown conversation id", async () => {
    /** A typo must not be reported as a successful recovery. */

    // GIVEN no conversation with the requested id
    const conversationId = "00000000-0000-0000-0000-000000000000";

    // WHEN it is pruned
    const call = () =>
      pruneRoute.handler({ body: { conversationId }, headers: CONFIRM });

    // THEN the route reports it as not found
    expect(call).toThrow(/Conversation not found/);
  });
});
