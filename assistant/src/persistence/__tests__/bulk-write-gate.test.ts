import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import { assertNotLiveDb } from "../../__tests__/assert-not-live-db.js";
import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { bulkWriteGateHolder, withBulkWriteGate } from "../bulk-write-gate.js";
import { deleteConversationRowsInBatches } from "../conversation-row-batch-delete.js";
import { copyForkMessagesViaSubprocess } from "../fork-message-copy.js";

/** A promise whose resolution the test controls. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("withBulkWriteGate", () => {
  test("runs callers FIFO, one at a time", async () => {
    const events: string[] = [];
    const first = deferred();

    const run = (id: string, block?: Promise<void>) =>
      withBulkWriteGate(id, async () => {
        events.push(`${id}:start`);
        if (block) {
          await block;
        }
        events.push(`${id}:end`);
      });

    const p1 = run("a", first.promise);
    const p2 = run("b");
    const p3 = run("c");

    await Bun.sleep(20);
    expect(events).toEqual(["a:start"]);

    first.release();
    await Promise.all([p1, p2, p3]);
    expect(events).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  test("releases on throw and propagates the error", async () => {
    const failing = withBulkWriteGate("boom", async () => {
      throw new Error("kaput");
    });
    await expect(failing).rejects.toThrow("kaput");

    const after = await withBulkWriteGate("after", async () => 42);
    expect(after).toBe(42);
  });

  test("returns the wrapped value and reports the holder label", async () => {
    const holdersWhileRunning: Array<string | null> = [];
    const value = await withBulkWriteGate("labelled", async () => {
      holdersWhileRunning.push(bulkWriteGateHolder());
      return "ok";
    });
    expect(value).toBe("ok");
    expect(holdersWhileRunning).toEqual(["labelled"]);
    expect(bulkWriteGateHolder()).toBeNull();
  });
});

describe("gated bulk writers", () => {
  test("fork message-copy queues behind a held gate", async () => {
    const holder = deferred();
    const holding = withBulkWriteGate("holder", () => holder.promise);

    let copySettled = false;
    const copy = copyForkMessagesViaSubprocess({
      forkConversationId: "fork-1",
      idPairs: [{ oldId: "old-1", newId: "new-1" }],
      forceInProcess: true,
    }).then((result) => {
      copySettled = true;
      return result;
    });

    await Bun.sleep(20);
    expect(copySettled).toBe(false);

    holder.release();
    await holding;
    await copy;
    expect(copySettled).toBe(true);
  });

  test("empty fork message-copy skips the gate entirely", async () => {
    const holder = deferred();
    const holding = withBulkWriteGate("holder", () => holder.promise);

    const result = await copyForkMessagesViaSubprocess({
      forkConversationId: "fork-1",
      idPairs: [],
    });
    expect(result.ok).toBe(true);

    holder.release();
    await holding;
  });

  test("main-DB batched delete queues behind a held gate", async () => {
    const holder = deferred();
    const holding = withBulkWriteGate("holder", () => holder.promise);

    let deleteSettled = false;
    const del = deleteConversationRowsInBatches({
      conversationId: "conv-1",
      table: "messages",
      forceInProcess: true,
    }).then((result) => {
      deleteSettled = true;
      return result;
    });

    await Bun.sleep(20);
    expect(deleteSettled).toBe(false);

    holder.release();
    await holding;
    await del;
    expect(deleteSettled).toBe(true);
  });

  test("dedicated-file batched delete bypasses the gate", async () => {
    const dbPath = join(tmpdir(), `bulk-write-gate-test-${Date.now()}.db`);
    const holder = deferred();
    const holding = withBulkWriteGate("holder", () => holder.promise);

    try {
      // Must settle while the gate is still held — a dedicated file has its
      // own write lock, so its drain never queues behind main-DB streams.
      const result = await deleteConversationRowsInBatches({
        conversationId: "conv-1",
        table: "some_table",
        dbPath,
        forceInProcess: true,
      });
      expect(bulkWriteGateHolder()).toBe("holder");
      expect(result.backend).toBe("in-process-blocking");
    } finally {
      holder.release();
      await holding;
      assertNotLiveDb(dbPath);
      rmSync(dbPath, { force: true });
    }
  });
});
