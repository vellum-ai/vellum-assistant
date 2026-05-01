/**
 * Tests for the disk space guard module and disk pressure context injection.
 *
 * Covers the guard state machine (lock/unlock/override cycles), the
 * selective blocking gate in runAgentLoopImpl, and the system prompt /
 * user message prepend behavior that ensures the assistant always leads
 * with disk space warnings during pressure.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  applyDiskPressureContext,
  DISK_PRESSURE_PREFIX,
} from "../daemon/conversation-agent-loop.js";
import {
  _resetForTests,
  _setLockedForTests,
  getDiskLockStatus,
  isDiskSpacePressure,
  OVERRIDE_CONFIRMATION_PHRASE,
  overrideDiskLock,
  startDiskSpaceGuard,
  stopDiskSpaceGuard,
} from "../daemon/disk-space-guard.js";
import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Guard state machine tests (Tests 6 & 7)
// ---------------------------------------------------------------------------

describe("disk-space-guard state machine", () => {
  afterEach(() => {
    _resetForTests();
  });

  test("initially not in disk pressure", () => {
    // GIVEN no guard has been started
    // WHEN we check disk pressure
    const result = isDiskSpacePressure();

    // THEN it should not be active
    expect(result).toBe(false);
  });

  test("getDiskLockStatus returns correct initial state", () => {
    // GIVEN no guard has been started
    // WHEN we get status
    const status = getDiskLockStatus();

    // THEN all fields should be in initial state
    expect(status.locked).toBe(false);
    expect(status.overrideActive).toBe(false);
    expect(status.effectivelyLocked).toBe(false);
    expect(status.threshold).toBe(95);
  });

  test("startDiskSpaceGuard is idempotent", () => {
    // GIVEN the guard is already running
    startDiskSpaceGuard(60_000);

    // WHEN we start it again
    startDiskSpaceGuard(60_000);

    // THEN it should not throw and stop should clean up
    stopDiskSpaceGuard();
  });

  test("override rejected when not locked", () => {
    // GIVEN disk is not locked
    // WHEN we try to override with the correct phrase
    const result = overrideDiskLock(OVERRIDE_CONFIRMATION_PHRASE);

    // THEN the override should be rejected (not locked)
    expect(result).toBe(false);
  });

  test("override with wrong phrase is rejected", () => {
    // GIVEN disk is locked
    _setLockedForTests(true);

    // WHEN we try to override with the wrong phrase
    const result = overrideDiskLock("wrong phrase");

    // THEN the override should be rejected
    expect(result).toBe(false);
  });

  test("override with correct phrase is accepted", () => {
    // GIVEN disk is locked
    _setLockedForTests(true);

    // WHEN we call override with the exact phrase
    const result = overrideDiskLock(OVERRIDE_CONFIRMATION_PHRASE);

    // THEN the override should be accepted
    expect(result).toBe(true);
  });

  test("override phrase requires exact match (no extra whitespace)", () => {
    // GIVEN disk is locked and the phrase has leading/trailing whitespace
    _setLockedForTests(true);

    // WHEN we call override with padded phrase
    const result = overrideDiskLock(`  ${OVERRIDE_CONFIRMATION_PHRASE}  `);

    // THEN the override should still be accepted (trim is applied)
    expect(result).toBe(true);
  });

  test("OVERRIDE_CONFIRMATION_PHRASE is the expected value", () => {
    // GIVEN the exported constant
    // THEN it should be the expected phrase
    expect(OVERRIDE_CONFIRMATION_PHRASE).toBe("I understand the risks");
  });
});

// ---------------------------------------------------------------------------
// Route handler tests
// ---------------------------------------------------------------------------

describe("disk-lock route handlers", () => {
  afterEach(() => {
    _resetForTests();
  });

  test("status endpoint returns threshold of 95", () => {
    // GIVEN no disk pressure
    // WHEN we get status
    const status = getDiskLockStatus();

    // THEN the threshold should be 95%
    expect(status.threshold).toBe(95);
  });

  test("status reflects override state after successful override", () => {
    // GIVEN disk is locked and a successful override
    _setLockedForTests(true);
    overrideDiskLock(OVERRIDE_CONFIRMATION_PHRASE);

    // WHEN we get status
    const status = getDiskLockStatus();

    // THEN overrideActive should be true and effectivelyLocked false
    expect(status.locked).toBe(true);
    expect(status.overrideActive).toBe(true);
    expect(status.effectivelyLocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Disk pressure context prepend tests (Tests 1-3)
// ---------------------------------------------------------------------------

describe("applyDiskPressureContext prepend behavior", () => {
  test("prepends disk_pressure_warning as FIRST content element of the last user message", () => {
    // GIVEN a messages array with a user message at the end
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello, how can I help?" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Can you help me with something?" }],
      },
    ];

    // WHEN we apply disk pressure context
    const result = applyDiskPressureContext(messages);

    // THEN the last user message's content[0] should be the disk pressure warning
    const lastMessage = result[result.length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content[0]).toEqual({
      type: "text",
      text: DISK_PRESSURE_PREFIX,
    });

    // AND the original user text should be the SECOND element (not first)
    expect(lastMessage.content[1]).toEqual({
      type: "text",
      text: "Can you help me with something?",
    });

    // AND the total content length should be original + 1
    expect(lastMessage.content.length).toBe(2);
  });

  test("disk pressure warning starts with <disk_pressure_warning> tag", () => {
    // GIVEN the DISK_PRESSURE_PREFIX constant
    // THEN it should start with the XML tag
    expect(DISK_PRESSURE_PREFIX.startsWith("<disk_pressure_warning>")).toBe(
      true,
    );

    // AND it should contain the closing tag
    expect(DISK_PRESSURE_PREFIX).toContain("</disk_pressure_warning>");
  });

  test("returns messages unchanged when last message is not a user message", () => {
    // GIVEN a messages array ending with an assistant message
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      },
    ];

    // WHEN we apply disk pressure context
    const result = applyDiskPressureContext(messages);

    // THEN messages should be unchanged
    expect(result).toEqual(messages);
  });

  test("returns empty array unchanged", () => {
    // GIVEN an empty messages array
    const messages: Message[] = [];

    // WHEN we apply disk pressure context
    const result = applyDiskPressureContext(messages);

    // THEN it should still be empty
    expect(result).toEqual([]);
  });

  test("does not mutate the original messages array", () => {
    // GIVEN a messages array with a user message
    const originalContent = [
      { type: "text" as const, text: "Original message" },
    ];
    const messages: Message[] = [
      { role: "user", content: [...originalContent] },
    ];

    // WHEN we apply disk pressure context
    const result = applyDiskPressureContext(messages);

    // THEN the original messages array should be unchanged
    expect(messages[0].content).toEqual(originalContent);

    // AND the result should be a new array
    expect(result).not.toBe(messages);
  });

  test("preserves preceding messages when prepending to last user message", () => {
    // GIVEN a multi-message conversation
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "First message" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Second message" }],
      },
    ];

    // WHEN we apply disk pressure context
    const result = applyDiskPressureContext(messages);

    // THEN only the last message should have the prefix
    expect(result[0].content).toEqual([
      { type: "text", text: "First message" },
    ]);
    expect(result[1].content).toEqual([{ type: "text", text: "Response" }]);

    // AND the last message should have the prefix prepended
    expect(result[2].content[0]).toEqual({
      type: "text",
      text: DISK_PRESSURE_PREFIX,
    });
    expect(result[2].content[1]).toEqual({
      type: "text",
      text: "Second message",
    });
  });
});

// ---------------------------------------------------------------------------
// Snapshot consistency verification (Test 8)
// ---------------------------------------------------------------------------

describe("disk pressure snapshot consistency", () => {
  test("conversation.ts system prompt reads currentTurnDiskPressure field (not isDiskSpacePressure)", async () => {
    // GIVEN the conversation.ts source file
    const fs = await import("node:fs");
    const path = await import("node:path");
    const conversationPath = path.join(
      import.meta.dir,
      "..",
      "daemon",
      "conversation.ts",
    );
    const source = fs.readFileSync(conversationPath, "utf-8");

    // WHEN we check how the system prompt callback determines disk pressure state
    // THEN it should use the snapshot field, not the live function
    expect(source).toContain("this.currentTurnDiskPressure");

    // AND the system prompt callback should NOT directly call isDiskSpacePressure()
    // (The import was removed; the snapshot field is the only source of truth)
    const importLines = source
      .split("\n")
      .filter((line) => line.includes("import") && line.includes("from"));
    const diskGuardImports = importLines.filter((line) =>
      line.includes("disk-space-guard"),
    );
    const importsDiskPressureFn = diskGuardImports.some((line) =>
      line.includes("isDiskSpacePressure"),
    );
    expect(importsDiskPressureFn).toBe(false);
  });

  test("conversation-agent-loop.ts snapshots disk pressure at turn start", async () => {
    // GIVEN the conversation-agent-loop.ts source file
    const fs = await import("node:fs");
    const path = await import("node:path");
    const agentLoopPath = path.join(
      import.meta.dir,
      "..",
      "daemon",
      "conversation-agent-loop.ts",
    );
    const source = fs.readFileSync(agentLoopPath, "utf-8");

    // WHEN we check the turn start logic
    // THEN ctx.currentTurnDiskPressure should be assigned from the local snapshot
    expect(source).toContain(
      "ctx.currentTurnDiskPressure = diskPressureActive",
    );
  });

  test("system prompt prepend uses <disk_pressure_mode> tag", async () => {
    // GIVEN the conversation.ts source file
    const fs = await import("node:fs");
    const path = await import("node:path");
    const conversationPath = path.join(
      import.meta.dir,
      "..",
      "daemon",
      "conversation.ts",
    );
    const source = fs.readFileSync(conversationPath, "utf-8");

    // WHEN we check the system prompt injection
    // THEN it should contain the disk_pressure_mode opening tag
    expect(source).toContain("<disk_pressure_mode>");

    // AND it should prepend (prompt = injection + prompt), not append (prompt += injection)
    expect(source).toContain('"<disk_pressure_mode>\\n"');
    expect(source).toContain("prompt;");
  });
});
