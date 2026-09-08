import { rmSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import {
  getDaemonBootTimePath,
  recordDaemonBootTime,
} from "../../daemon-boot-time.js";
import { recoverStrandedDeliveryEvents } from "../stranded-delivery-events.js";

await initializeDb();

/** Payload shape of an event whose turn ran and whose delivery is owed. */
const DELIVERABLE_PAYLOAD = JSON.stringify({
  content: "hello",
  replyCallbackUrl: "https://gateway.local/deliver/slack?threadTs=1.2",
  externalChatId: "C123",
  replyMessageId: "assistant-row-1",
});

/** Payload shape of an intercept-settled event (no reply delivery owed). */
const INTERCEPT_PAYLOAD = JSON.stringify({
  content: "reaction",
  replyCallbackUrl: "https://gateway.local/deliver/slack?threadTs=1.2",
});

// Seed rows via raw SQL rather than delivery-crud / conversation-crud helpers:
// those modules are `mock.module`-replaced by other test files, and bun's mocks
// are process-global, so depending on them here makes this file fail when
// co-run with a mocking file. Raw SQL against the shared DB is isolation-proof.
function seedEvent(
  id: string,
  opts: {
    createdAt: number;
    processingStatus: string;
    deliveryStatus: string;
    rawPayload: string | null;
  },
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
     VALUES (?, 'slack', ?, ?, ?, ?, ?, 0, 0, NULL, ?, 0, ?, ?)`,
  ).run(
    id,
    `chat-${id}`,
    `msg-${id}`,
    conversationId,
    opts.deliveryStatus,
    opts.processingStatus,
    opts.rawPayload,
    opts.createdAt,
    opts.createdAt,
  );
  return id;
}

function statusOf(eventId: string): {
  delivery_status: string;
  retry_after: number | null;
} {
  return getSqliteFrom(getDb())
    .query(
      `SELECT delivery_status, retry_after
         FROM channel_inbound_events WHERE id = ?`,
    )
    .get(eventId) as { delivery_status: string; retry_after: number | null };
}

describe("recoverStrandedDeliveryEvents", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM channel_inbound_events");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM conversations");
    rmSync(getDaemonBootTimePath(), { force: true });
  });

  test("promotes a pre-boot processed event whose delivery never finalized", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const eventId = seedEvent("stranded", {
      createdAt: bootTime - 5_000,
      processingStatus: "processed",
      deliveryStatus: "pending",
      rawPayload: DELIVERABLE_PAYLOAD,
    });

    recoverStrandedDeliveryEvents();

    const row = statusOf(eventId);
    expect(row.delivery_status).toBe("failed"); // the delivery-retry arm selects it
    expect(row.retry_after).not.toBeNull();
  });

  test("leaves a processed+pending event created after boot (a live delivery owns it)", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const eventId = seedEvent("live", {
      createdAt: bootTime + 5_000,
      processingStatus: "processed",
      deliveryStatus: "pending",
      rawPayload: DELIVERABLE_PAYLOAD,
    });

    recoverStrandedDeliveryEvents();

    expect(statusOf(eventId).delivery_status).toBe("pending");
  });

  test("leaves intercept-settled events whose payload names no reply (no delivery owed)", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const eventId = seedEvent("intercept", {
      createdAt: bootTime - 5_000,
      processingStatus: "processed",
      deliveryStatus: "pending",
      rawPayload: INTERCEPT_PAYLOAD,
    });

    recoverStrandedDeliveryEvents();

    expect(statusOf(eventId).delivery_status).toBe("pending");
  });

  test("leaves a stranded-looking event with no stored payload (cannot be redelivered)", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const eventId = seedEvent("no-payload", {
      createdAt: bootTime - 5_000,
      processingStatus: "processed",
      deliveryStatus: "pending",
      rawPayload: null,
    });

    recoverStrandedDeliveryEvents();

    expect(statusOf(eventId).delivery_status).toBe("pending");
  });

  test("never touches events with a terminal delivery state", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const delivered = seedEvent("delivered", {
      createdAt: bootTime - 5_000,
      processingStatus: "processed",
      deliveryStatus: "delivered",
      rawPayload: DELIVERABLE_PAYLOAD,
    });
    const deadLetter = seedEvent("dead-letter", {
      createdAt: bootTime - 5_000,
      processingStatus: "processed",
      deliveryStatus: "dead_letter",
      rawPayload: DELIVERABLE_PAYLOAD,
    });

    recoverStrandedDeliveryEvents();

    expect(statusOf(delivered).delivery_status).toBe("delivered");
    expect(statusOf(deadLetter).delivery_status).toBe("dead_letter");
  });

  test("leaves unprocessed events to the orphaned-channel-events step", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    const eventId = seedEvent("still-pending", {
      createdAt: bootTime - 5_000,
      processingStatus: "pending",
      deliveryStatus: "pending",
      rawPayload: DELIVERABLE_PAYLOAD,
    });

    recoverStrandedDeliveryEvents();

    expect(statusOf(eventId).delivery_status).toBe("pending");
  });

  test("skips recovery when the daemon boot time is unavailable", () => {
    // No recordDaemonBootTime(): without the fence a live daemon's in-flight
    // delivery is indistinguishable from a dead process's stranded row.
    const eventId = seedEvent("no-fence", {
      createdAt: Date.now() - 5_000,
      processingStatus: "processed",
      deliveryStatus: "pending",
      rawPayload: DELIVERABLE_PAYLOAD,
    });

    recoverStrandedDeliveryEvents();

    expect(statusOf(eventId).delivery_status).toBe("pending");
  });
});
