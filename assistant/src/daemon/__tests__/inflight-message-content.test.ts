/**
 * Tests for the in-flight message content writer: lazy row flip to
 * `{ ref }` / `finalized = 0`, diffed delta appends, transparent mid-stream
 * reads through the row mapper, finalize folding inline + cleanup, and the
 * stranded-writer fold at the turn seam.
 */
import { existsSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";

import pino from "pino";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  addMessage,
  createConversation,
  getMessageById,
} from "../../persistence/conversation-crud.js";
import { getSqliteFrom } from "../../persistence/db-connection.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import type { ContentBlock } from "../../providers/types.js";
import {
  appendInflightSnapshot,
  createInflightContentWriter,
  finalizeInflightContent,
  finalizeStrandedInflightContent,
  type InflightContentWriter,
} from "../inflight-message-content.js";

await initializeDb();

const rlog = pino({ level: "silent" });

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

function rawRow(messageId: string): { content: string; finalized: number } {
  const sqlite = getSqliteFrom(getDb());
  return sqlite
    .query("SELECT content, finalized FROM messages WHERE id = ?")
    .get(messageId) as { content: string; finalized: number };
}

async function setup(): Promise<{
  conversationId: string;
  messageId: string;
  writer: InflightContentWriter;
}> {
  const conv = createConversation("inflight test");
  const msg = await addMessage(conv.id, "assistant", "[]", {
    skipIndexing: true,
  });
  const writer = createInflightContentWriter(conv.id, msg.id);
  if (!writer) {
    throw new Error("writer creation failed");
  }
  return { conversationId: conv.id, messageId: msg.id, writer };
}

describe("appendInflightSnapshot", () => {
  test("first append flips the row to { ref } / finalized = 0", async () => {
    const { messageId, writer } = await setup();
    expect(await appendInflightSnapshot(writer, [textBlock("hel")], rlog)).toBe(
      true,
    );
    const row = rawRow(messageId);
    expect(row.finalized).toBe(0);
    expect(JSON.parse(row.content)).toEqual({ ref: writer.ref });
    expect(existsSync(writer.absPath)).toBe(true);
  });

  test("mid-stream reads resolve the folded file through the row mapper", async () => {
    const { conversationId, messageId, writer } = await setup();
    await appendInflightSnapshot(writer, [textBlock("hel")], rlog);
    await appendInflightSnapshot(
      writer,
      [textBlock("hello"), textBlock("world")],
      rlog,
    );
    const row = getMessageById(messageId, conversationId);
    expect(row?.content).toEqual([textBlock("hello"), textBlock("world")]);
    expect(row?.finalized).toBe(0);
  });

  test("unchanged blocks are not re-appended (diffed deltas)", async () => {
    const { writer } = await setup();
    const stable = textBlock("stable block");
    await appendInflightSnapshot(writer, [stable, textBlock("v1")], rlog);
    const seqAfterFirst = writer.seq;
    await appendInflightSnapshot(writer, [stable, textBlock("v2")], rlog);
    // Only the changed index consumed a seq.
    expect(writer.seq).toBe(seqAfterFirst + 1);
  });
});

describe("finalizeInflightContent", () => {
  test("folds inline, sets finalized = 1, deletes the file", async () => {
    const { conversationId, messageId, writer } = await setup();
    await appendInflightSnapshot(writer, [textBlock("partial")], rlog);
    const final = [textBlock("final answer")];
    expect(
      await finalizeInflightContent(
        writer,
        messageId,
        JSON.stringify(final),
        rlog,
        { model: "test-model" },
      ),
    ).toBe(true);
    const row = rawRow(messageId);
    expect(row.finalized).toBe(1);
    expect(JSON.parse(row.content)).toEqual(final);
    expect(existsSync(writer.absPath)).toBe(false);
    const mapped = getMessageById(messageId, conversationId);
    expect(mapped?.content).toEqual(final);
    expect(JSON.parse(mapped?.metadata ?? "{}").model).toBe("test-model");
  });

  test("works for rows that never went in-flight (fast replies)", async () => {
    const { messageId, writer } = await setup();
    const final = [textBlock("quick")];
    expect(
      await finalizeInflightContent(
        writer,
        messageId,
        JSON.stringify(final),
        rlog,
      ),
    ).toBe(true);
    const row = rawRow(messageId);
    expect(row.finalized).toBe(1);
    expect(JSON.parse(row.content)).toEqual(final);
  });
});

describe("finalizeStrandedInflightContent", () => {
  test("folds leftover writers from the row's resolved content", async () => {
    const { conversationId, messageId, writer } = await setup();
    await appendInflightSnapshot(
      writer,
      [textBlock("cancelled mid-stream")],
      rlog,
    );
    const writers = new Map([[messageId, writer]]);
    await finalizeStrandedInflightContent(writers, rlog);
    expect(writers.size).toBe(0);
    const row = rawRow(messageId);
    expect(row.finalized).toBe(1);
    expect(JSON.parse(row.content)).toEqual([
      textBlock("cancelled mid-stream"),
    ]);
    expect(existsSync(writer.absPath)).toBe(false);
    expect(getMessageById(messageId, conversationId)?.content).toEqual([
      textBlock("cancelled mid-stream"),
    ]);
  });

  test("skips writers that never marked the row", async () => {
    const { messageId, writer } = await setup();
    const writers = new Map([[messageId, writer]]);
    await finalizeStrandedInflightContent(writers, rlog);
    expect(writers.size).toBe(0);
    // Row untouched: still the reserved placeholder, finalized default 1.
    expect(rawRow(messageId).finalized).toBe(1);
  });
});
