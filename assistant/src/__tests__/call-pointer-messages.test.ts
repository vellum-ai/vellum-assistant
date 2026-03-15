import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "call-pointer-messages-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  addPointerMessage,
  formatDuration,
  resetPointerMessageProcessor,
  setPointerMessageProcessor,
} from "../calls/call-pointer-messages.js";
import { addMessage, getMessages } from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { conversations } from "../memory/schema.js";

initializeDb();

function ensureConversation(
  id: string,
  options?: { conversationType?: string; originChannel?: string },
): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Conversation ${id}`,
      createdAt: now,
      updatedAt: now,
      ...(options?.conversationType
        ? { conversationType: options.conversationType }
        : {}),
      ...(options?.originChannel
        ? { originChannel: options.originChannel }
        : {}),
    })
    .run();
}

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function getLatestAssistantText(conversationId: string): string {
  const rows = getMessages(conversationId).filter(
    (m) => m.role === "assistant",
  );
  expect(rows.length).toBeGreaterThan(0);
  const latest = rows[rows.length - 1];
  const parsed = JSON.parse(latest.content) as Array<{
    type: string;
    text?: string;
  }>;
  return parsed
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

describe("formatDuration", () => {
  test("formats seconds-only durations", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(30000)).toBe("30s");
    expect(formatDuration(59000)).toBe("59s");
  });

  test("formats minutes-only durations", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(120000)).toBe("2m");
    expect(formatDuration(300000)).toBe("5m");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  test("rounds sub-second durations", () => {
    expect(formatDuration(500)).toBe("1s");
    expect(formatDuration(1499)).toBe("1s");
    expect(formatDuration(1500)).toBe("2s");
  });

  test("handles zero duration", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("addPointerMessage", () => {
  beforeEach(() => {
    resetTables();
  });

  afterEach(() => {
    resetPointerMessageProcessor();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* best effort */
    }
  });

  test("adds a started pointer message", () => {
    const convId = "conv-ptr-started";
    ensureConversation(convId);
    addPointerMessage(convId, "started", "+15551234567");
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Call to +15551234567 started");
    expect(text).not.toContain("See voice thread");
  });

  test("started pointer message does not set userMessageChannel metadata", () => {
    const convId = "conv-ptr-no-channel";
    ensureConversation(convId);
    addPointerMessage(convId, "started", "+15551234567");
    const rows = getMessages(convId).filter((m) => m.role === "assistant");
    expect(rows.length).toBe(1);
    const metadata = rows[0].metadata ? JSON.parse(rows[0].metadata) : null;
    // metadata should be null/undefined — no userMessageChannel set
    expect(metadata?.userMessageChannel).toBeUndefined();
  });

  test("adds a started pointer message with verification code", () => {
    const convId = "conv-ptr-started-vc";
    ensureConversation(convId);
    addPointerMessage(convId, "started", "+15551234567", {
      verificationCode: "42",
    });
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Verification code: 42");
  });

  test("adds a completed pointer message without duration", () => {
    const convId = "conv-ptr-completed";
    ensureConversation(convId);
    addPointerMessage(convId, "completed", "+15559876543");
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Call to +15559876543 completed");
    expect(text).not.toContain("(");
  });

  test("adds a completed pointer message with duration", () => {
    const convId = "conv-ptr-completed-d";
    ensureConversation(convId);
    addPointerMessage(convId, "completed", "+15559876543", {
      duration: "2m 30s",
    });
    const text = getLatestAssistantText(convId);
    expect(text).toContain("completed (2m 30s)");
  });

  test("adds a failed pointer message without reason", () => {
    const convId = "conv-ptr-failed";
    ensureConversation(convId);
    addPointerMessage(convId, "failed", "+15559876543");
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Call to +15559876543 failed");
  });

  test("adds a failed pointer message with reason", () => {
    const convId = "conv-ptr-failed-r";
    ensureConversation(convId);
    addPointerMessage(convId, "failed", "+15559876543", {
      reason: "no answer",
    });
    const text = getLatestAssistantText(convId);
    expect(text).toContain("failed: no answer");
  });

  test("adds a verification_succeeded pointer message", () => {
    const convId = "conv-ptr-gv-success";
    ensureConversation(convId);
    addPointerMessage(convId, "verification_succeeded", "+15559876543");
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Guardian verification");
    expect(text).toContain("+15559876543");
    expect(text).toContain("succeeded");
  });

  test("adds a verification_failed pointer message without reason", () => {
    const convId = "conv-ptr-gv-fail";
    ensureConversation(convId);
    addPointerMessage(convId, "verification_failed", "+15559876543");
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Guardian verification");
    expect(text).toContain("+15559876543");
    expect(text).toContain("failed");
  });

  test("adds a verification_failed pointer message with reason", () => {
    const convId = "conv-ptr-gv-fail-r";
    ensureConversation(convId);
    addPointerMessage(convId, "verification_failed", "+15559876543", {
      reason: "Max attempts exceeded",
    });
    const text = getLatestAssistantText(convId);
    expect(text).toContain("failed: Max attempts exceeded");
  });

  // Trust-aware tests

  test("untrusted audience uses deterministic fallback even with processor set", () => {
    const convId = "conv-ptr-untrusted";
    ensureConversation(convId, { conversationType: "standard" });

    const processorCalled = { value: false };
    setPointerMessageProcessor(async () => {
      processorCalled.value = true;
    });

    addPointerMessage(convId, "started", "+15551234567");
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Call to +15551234567 started");
    // processor not called because standard conversationType + no origin = untrusted
    expect(processorCalled.value).toBe(false);
  });

  test("explicit untrusted audience mode skips processor", () => {
    const convId = "conv-ptr-explicit-untrusted";
    ensureConversation(convId, { conversationType: "private" });

    const processorCalled = { value: false };
    setPointerMessageProcessor(async () => {
      processorCalled.value = true;
    });

    addPointerMessage(
      convId,
      "started",
      "+15551234567",
      undefined,
      "untrusted",
    );
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Call to +15551234567 started");
    expect(processorCalled.value).toBe(false);
  });

  test("trusted audience routes through daemon processor with required facts", async () => {
    const convId = "conv-ptr-trusted";
    ensureConversation(convId, { conversationType: "private" });

    let capturedInstruction = "";
    let capturedFacts: string[] = [];
    setPointerMessageProcessor(async (_convId, instruction, requiredFacts) => {
      capturedInstruction = instruction;
      capturedFacts = requiredFacts ?? [];
    });

    await addPointerMessage(convId, "completed", "+15559876543", {
      duration: "1m",
    });
    // Processor was called with a structured instruction
    expect(capturedInstruction).toContain("[CALL_STATUS_EVENT]");
    expect(capturedInstruction).toContain("+15559876543");
    expect(capturedInstruction).toContain("completed");
    expect(capturedInstruction).toContain("1m");
    // Required facts include phone number, duration, and outcome keyword
    expect(capturedFacts).toContain("+15559876543");
    expect(capturedFacts).toContain("1m");
    expect(capturedFacts).toContain("completed");
  });

  test("trusted audience falls back to deterministic on processor failure", async () => {
    const convId = "conv-ptr-processor-fail";
    ensureConversation(convId, { conversationType: "private" });

    setPointerMessageProcessor(async () => {
      throw new Error("Daemon unavailable");
    });

    await addPointerMessage(convId, "failed", "+15559876543", {
      reason: "busy",
    });
    // Falls back to deterministic — written directly to conversation store
    const text = getLatestAssistantText(convId);
    expect(text).toContain("failed: busy");
  });

  test("vellum origin channel is detected as trusted audience", async () => {
    const convId = "conv-ptr-vellum";
    ensureConversation(convId, { originChannel: "vellum" });

    let processorCalled = false;
    setPointerMessageProcessor(async () => {
      processorCalled = true;
    });

    await addPointerMessage(convId, "failed", "+15559876543", {
      reason: "busy",
    });
    expect(processorCalled).toBe(true);
  });

  test("missing conversation defaults to untrusted", () => {
    const convId = "conv-ptr-no-signals";
    ensureConversation(convId);

    const processorCalled = { value: false };
    setPointerMessageProcessor(async () => {
      processorCalled.value = true;
    });

    addPointerMessage(convId, "started", "+15551234567");
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Call to +15551234567 started");
    expect(processorCalled.value).toBe(false);
  });

  // Provenance trust class tests

  test("guardian provenance trust class is detected as trusted audience", async () => {
    const convId = "conv-ptr-guardian-provenance";
    ensureConversation(convId, { conversationType: "standard" });
    // Add a user message with guardian provenance metadata
    await addMessage(convId, "user", "hello", {
      provenanceTrustClass: "guardian",
    });

    let processorCalled = false;
    setPointerMessageProcessor(async () => {
      processorCalled = true;
    });

    await addPointerMessage(convId, "completed", "+15559876543");
    expect(processorCalled).toBe(true);
  });

  test("trusted_contact provenance trust class is detected as trusted audience", async () => {
    const convId = "conv-ptr-tc-provenance";
    ensureConversation(convId, { conversationType: "standard" });
    // Add a user message with trusted_contact provenance metadata
    await addMessage(convId, "user", "hello", {
      provenanceTrustClass: "trusted_contact",
    });

    let processorCalled = false;
    setPointerMessageProcessor(async () => {
      processorCalled = true;
    });

    await addPointerMessage(convId, "completed", "+15559876543");
    expect(processorCalled).toBe(true);
  });

  test("unknown provenance trust class does not grant trusted audience", () => {
    const convId = "conv-ptr-unknown-provenance";
    ensureConversation(convId, { conversationType: "standard" });
    addMessage(convId, "user", "hello", { provenanceTrustClass: "unknown" });

    const processorCalled = { value: false };
    setPointerMessageProcessor(async () => {
      processorCalled.value = true;
    });

    addPointerMessage(convId, "started", "+15551234567");
    const text = getLatestAssistantText(convId);
    expect(text).toContain("Call to +15551234567 started");
    expect(processorCalled.value).toBe(false);
  });
});
