/**
 * Tests for the in-flight message content writer: rows born `{ ref }` /
 * `finalized = 0` at reserve, event-seq-stamped diffed appends, transparent
 * mid-stream reads through the row mapper, finalize folding inline +
 * cleanup, and the stranded-writer fold at the turn seam.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";

import pino from "pino";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  createConversation,
  getMessageById,
  reserveMessage,
} from "../../persistence/conversation-crud.js";
import { getDb, getSqliteFrom } from "../../persistence/db-connection.js";
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

/** Mirror the reserve seam: writer first, row born with its ref. */
async function reserveInflight(): Promise<{
  conversationId: string;
  messageId: string;
  writer: InflightContentWriter;
}> {
  const conv = createConversation("inflight test");
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

describe("reserve born in-flight", () => {
  test("the row is created holding { ref } with finalized = 0", async () => {
    const { messageId, writer } = await reserveInflight();
    const row = rawRow(messageId);
    expect(row.finalized).toBe(0);
    expect(JSON.parse(row.content)).toEqual({ ref: writer.ref });
    // No delta file exists until the first partial flush.
    expect(existsSync(writer.absPath)).toBe(false);
  });

  test("a never-flushed in-flight row resolves to empty content", async () => {
    const { conversationId, messageId } = await reserveInflight();
    expect(getMessageById(messageId, conversationId)?.content).toEqual([]);
  });
});

describe("appendInflightSnapshot", () => {
  test("appends touch only the file — the row keeps its { ref }", async () => {
    const { messageId, writer } = await reserveInflight();
    expect(appendInflightSnapshot(writer, [textBlock("hel")], 7, rlog)).toBe(
      true,
    );
    const row = rawRow(messageId);
    expect(row.finalized).toBe(0);
    expect(JSON.parse(row.content)).toEqual({ ref: writer.ref });
    expect(existsSync(writer.absPath)).toBe(true);
  });

  test("mid-stream reads resolve the folded file through the row mapper", async () => {
    const { conversationId, messageId, writer } = await reserveInflight();
    appendInflightSnapshot(writer, [textBlock("hel")], 1, rlog);
    appendInflightSnapshot(
      writer,
      [textBlock("hello"), textBlock("world")],
      2,
      rlog,
    );
    const row = getMessageById(messageId, conversationId);
    expect(row?.content).toEqual([textBlock("hello"), textBlock("world")]);
    expect(row?.finalized).toBe(0);
  });

  test("delta lines carry the triggering event seq, unchanged blocks skipped", async () => {
    const { writer } = await reserveInflight();
    const stable = textBlock("stable block");
    appendInflightSnapshot(writer, [stable, textBlock("v1")], 41, rlog);
    appendInflightSnapshot(writer, [stable, textBlock("v2")], 55, rlog);
    const lines = readFileSync(writer.absPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { i: number; seq: number });
    // First flush wrote both blocks at seq 41; the second wrote only the
    // changed index at seq 55.
    expect(lines.map((l) => [l.i, l.seq])).toEqual([
      [0, 41],
      [1, 41],
      [1, 55],
    ]);
  });

  test("a flush without an event seq stays monotonic past the last stamp", async () => {
    const { writer } = await reserveInflight();
    appendInflightSnapshot(writer, [textBlock("v1")], 10, rlog);
    appendInflightSnapshot(writer, [textBlock("v2")], undefined, rlog);
    const lines = readFileSync(writer.absPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { seq: number });
    expect(lines.map((l) => l.seq)).toEqual([10, 11]);
  });
});

describe("finalizeInflightContent", () => {
  test("folds inline, sets finalized = 1, deletes the file", async () => {
    const { conversationId, messageId, writer } = await reserveInflight();
    appendInflightSnapshot(writer, [textBlock("partial")], 1, rlog);
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

  test("finalizes fast replies that never created the file", async () => {
    const { messageId, writer } = await reserveInflight();
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
    const { conversationId, messageId, writer } = await reserveInflight();
    appendInflightSnapshot(
      writer,
      [textBlock("cancelled mid-stream")],
      1,
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

  test("skips rows another path already finalized", async () => {
    const { messageId, writer } = await reserveInflight();
    await finalizeInflightContent(
      writer,
      messageId,
      JSON.stringify([textBlock("done")]),
      rlog,
    );
    const writers = new Map([[messageId, writer]]);
    await finalizeStrandedInflightContent(writers, rlog);
    expect(writers.size).toBe(0);
    expect(JSON.parse(rawRow(messageId).content)).toEqual([textBlock("done")]);
  });
});
