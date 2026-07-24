import { rmSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import {
  getDaemonBootTimePath,
  recordDaemonBootTime,
} from "../../daemon-boot-time.js";
import { recoverOrphanedChannelEvents } from "../orphaned-channel-events.js";

await initializeDb();

// Seed rows via raw SQL rather than delivery-crud / conversation-crud helpers:
// those modules are `mock.module`-replaced by other test files, and bun's mocks
// are process-global, so depending on them here makes this file fail when
// co-run with a mocking file. Raw SQL against the shared DB is isolation-proof.
function seedEvent(
  id: string,
  opts: { createdAt: number; processingStatus: string; withPayload: boolean },
): string {
  const db = getSqliteFrom(getDb());
  const conversationId = `conv-${id}`;
  db.query(
    `INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`,
  ).run(conversationId, opts.createdAt, opts.createdAt);
  db.query(
    `INSERT INTO channel_inbound_events
       (id, source_channel, external_chat_id, external_message_id,
        conversation_id, delivery_status, processing_status, processing_attempts,
        delivery_attempts, retry_after, raw_payload, delivered_segment_count,
        created_at, updated_at)
     VALUES (?, 'slack', ?, ?, ?, 'pending', ?, 0, 0, NULL, ?, 0, ?, ?)`,
  ).run(
    id,
    `chat-${id}`,
    `msg-${id}`,
    conversationId,
    opts.processingStatus,
    opts.withPayload ? '{"content":"recover me"}' : null,
    opts.createdAt,
    opts.createdAt,
  );
  return id;
}

function statusOf(eventId: string): {
  processing_status: string;
  retry_after: number | null;
} {
  return getSqliteFrom(getDb())
    .query(
      `SELECT processing_status, retry_after
         FROM channel_inbound_events WHERE id = ?`,
    )
    .get(eventId) as { processing_status: string; retry_after: number | null };
}

describe("recoverOrphanedChannelEvents", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM channel_inbound_events");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM conversations");
    rmSync(getDaemonBootTimePath(), { force: true });
  });

  test("promotes a pre-boot orphan pending event onto the retry path", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const eventId = seedEvent("orphan", {
      createdAt: bootTime - 5_000,
      processingStatus: "pending",
      withPayload: true,
    });

    recoverOrphanedChannelEvents();

    const row = statusOf(eventId);
    expect(row.processing_status).toBe("failed"); // now the sweep will select it
    expect(row.retry_after).not.toBeNull();
  });

  test("leaves a pending event created after boot (a live turn owns it)", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const eventId = seedEvent("live", {
      createdAt: bootTime + 5_000,
      processingStatus: "pending",
      withPayload: true,
    });

    recoverOrphanedChannelEvents();

    expect(statusOf(eventId).processing_status).toBe("pending");
  });

  test("leaves a pending event with no stored payload (cannot be replayed)", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const eventId = seedEvent("no-payload", {
      createdAt: bootTime - 5_000,
      processingStatus: "pending",
      withPayload: false,
    });

    recoverOrphanedChannelEvents();

    expect(statusOf(eventId).processing_status).toBe("pending");
  });

  test("never touches already-processed events", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const eventId = seedEvent("processed", {
      createdAt: bootTime - 5_000,
      processingStatus: "processed",
      withPayload: true,
    });

    recoverOrphanedChannelEvents();

    expect(statusOf(eventId).processing_status).toBe("processed");
  });

  test("skips recovery when the daemon boot time is unavailable", () => {
    // No recordDaemonBootTime() — without the fence a live daemon's just-arrived
    // pending row is indistinguishable from a dead process's orphan.
    const eventId = seedEvent("no-fence", {
      createdAt: Date.now() - 5_000,
      processingStatus: "pending",
      withPayload: true,
    });

    recoverOrphanedChannelEvents();

    expect(statusOf(eventId).processing_status).toBe("pending");
  });
});
