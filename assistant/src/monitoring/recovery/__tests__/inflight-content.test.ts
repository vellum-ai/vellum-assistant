/**
 * Tests for the monitor-process in-flight content recovery step: folding
 * `finalized = 0` rows a crashed daemon left behind, skipping rows a live turn
 * still owns (conversation mid-turn / fresh delta file), and GC of orphan
 * delta files.
 */
import { existsSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";

import pino from "pino";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  appendInflightSnapshot,
  createInflightContentWriter,
  type InflightContentWriter,
} from "../../../daemon/inflight-message-content.js";
import {
  createConversation,
  finalizeMessageContent,
  getMessageById,
  reserveMessage,
} from "../../../persistence/conversation-crud.js";
import { getDb, getSqliteFrom } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import type { ContentBlock } from "../../../providers/types.js";
import { recoverInflightContent } from "../inflight-content.js";

await initializeDb();

const rlog = pino({ level: "silent" });

function db() {
  return getSqliteFrom(getDb());
}

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

function rawRow(messageId: string): { content: string; finalized: number } {
  return db()
    .query("SELECT content, finalized FROM messages WHERE id = ?")
    .get(messageId) as { content: string; finalized: number };
}

function setProcessing(conversationId: string): void {
  db()
    .query("UPDATE conversations SET processing_started_at = ? WHERE id = ?")
    .run(Date.now(), conversationId);
}

/** Mirror the reserve seam: writer first, row born with its ref. */
async function reserveInflight(): Promise<{
  conversationId: string;
  messageId: string;
  writer: InflightContentWriter;
}> {
  const conv = createConversation("recovery test");
  const writer = createInflightContentWriter(conv.id);
  if (!writer) {
    throw new Error("writer creation failed");
  }
  const reserved = await reserveMessage(
    conv.id,
    "assistant",
    undefined,
    writer.ref,
  );
  writer.messageId = reserved.id;
  return { conversationId: conv.id, messageId: reserved.id, writer };
}

describe("recoverInflightContent — folding stranded rows", () => {
  test("folds a stranded row inline, sets finalized = 1, deletes its file", async () => {
    const { conversationId, messageId, writer } = await reserveInflight();
    appendInflightSnapshot(writer, [textBlock("streamed")], 1, rlog);
    expect(existsSync(writer.absPath)).toBe(true);

    const result = recoverInflightContent({ minAgeMs: 0 });

    expect(result.finalized).toBeGreaterThanOrEqual(1);
    const row = rawRow(messageId);
    expect(row.finalized).toBe(1);
    expect(JSON.parse(row.content)).toEqual([textBlock("streamed")]);
    expect(existsSync(writer.absPath)).toBe(false);
    expect(getMessageById(messageId, conversationId)?.content).toEqual([
      textBlock("streamed"),
    ]);
  });

  test("folds a never-flushed in-flight row to empty content", async () => {
    const { conversationId, messageId, writer } = await reserveInflight();
    expect(existsSync(writer.absPath)).toBe(false);

    recoverInflightContent({ minAgeMs: 0 });

    expect(rawRow(messageId).finalized).toBe(1);
    expect(getMessageById(messageId, conversationId)?.content).toEqual([]);
  });
});

describe("recoverInflightContent — ownership guards", () => {
  test("skips a row whose conversation is mid-turn, preserving its file", async () => {
    const { conversationId, messageId, writer } = await reserveInflight();
    appendInflightSnapshot(writer, [textBlock("live")], 1, rlog);
    setProcessing(conversationId);

    const result = recoverInflightContent({ minAgeMs: 0 });

    expect(result.skippedProcessing).toBeGreaterThanOrEqual(1);
    expect(rawRow(messageId).finalized).toBe(0);
    expect(existsSync(writer.absPath)).toBe(true);
  });

  test("the age floor preserves a freshly written delta file", async () => {
    const { messageId, writer } = await reserveInflight();
    appendInflightSnapshot(writer, [textBlock("fresh")], 1, rlog);
    // Row already finalized, but its file lingers (interrupted unlink).
    finalizeMessageContent(messageId, JSON.stringify([textBlock("fresh")]));
    expect(existsSync(writer.absPath)).toBe(true);

    // Default age floor treats the just-written file as possibly live.
    const result = recoverInflightContent();

    expect(result.filesDeleted).toBe(0);
    expect(existsSync(writer.absPath)).toBe(true);
  });
});

describe("recoverInflightContent — orphan file GC", () => {
  test("deletes a delta file whose row is already finalized", async () => {
    const { messageId, writer } = await reserveInflight();
    appendInflightSnapshot(writer, [textBlock("orphaned")], 1, rlog);
    // finalize the row without deleting its file (interrupted unlink).
    finalizeMessageContent(messageId, JSON.stringify([textBlock("orphaned")]));
    expect(rawRow(messageId).finalized).toBe(1);
    expect(existsSync(writer.absPath)).toBe(true);

    const result = recoverInflightContent({ minAgeMs: 0 });

    expect(result.filesDeleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(writer.absPath)).toBe(false);
  });
});
