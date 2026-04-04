/**
 * Tests that pending-interactions entries are cleaned up when a prompt
 * finishes (timeout, abort, resolve, dispose) via the onPromptReleased
 * callback, and that conversation disposal drops all entries including
 * host-tool interactions.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    timeouts: { permissionTimeoutSec: 0.1 },
    secretDetection: { enabled: false, allowOneTimeSend: false },
  }),
}));

mock.module("../security/redaction.js", () => ({
  redactSensitiveFields: (input: Record<string, unknown>) => input,
}));

import { PermissionPrompter } from "../permissions/prompter.js";
import { SecretPrompter } from "../permissions/secret-prompter.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

beforeEach(() => {
  pendingInteractions.clear();
});

afterEach(() => {
  pendingInteractions.clear();
});

// ---------------------------------------------------------------------------
// PermissionPrompter cleanup
// ---------------------------------------------------------------------------

describe("PermissionPrompter + pending-interactions cleanup", () => {
  test("confirmation timeout removes the pending interaction entry", async () => {
    let capturedRequestId = "";
    const prompter = new PermissionPrompter((msg: any) => {
      if (msg.requestId) capturedRequestId = msg.requestId;
    });
    prompter.setOnPromptReleased((requestId) => {
      pendingInteractions.drop(requestId);
    });

    // Start the prompt (this will time out after 100ms from our mock config)
    const resultPromise = prompter.prompt(
      "test_tool",
      { cmd: "ls" },
      "low",
      [],
      [],
    );

    // Register in pending-interactions as the server would
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedRequestId).not.toBe("");
    pendingInteractions.register(capturedRequestId, {
      conversation: null,
      conversationId: "conv-test",
      kind: "confirmation",
    });
    expect(pendingInteractions.get(capturedRequestId)).toBeDefined();

    // Wait for timeout
    const result = await resultPromise;
    expect(result.decision).toBe("deny");

    // The onPromptReleased callback should have dropped the entry
    expect(pendingInteractions.get(capturedRequestId)).toBeUndefined();
  });

  test("abort signal removes the pending interaction entry", async () => {
    let capturedRequestId = "";
    const prompter = new PermissionPrompter((msg: any) => {
      if (msg.requestId) capturedRequestId = msg.requestId;
    });
    prompter.setOnPromptReleased((requestId) => {
      pendingInteractions.drop(requestId);
    });

    const controller = new AbortController();

    const resultPromise = prompter.prompt(
      "test_tool",
      { cmd: "ls" },
      "low",
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    await new Promise((r) => setTimeout(r, 10));
    pendingInteractions.register(capturedRequestId, {
      conversation: null,
      conversationId: "conv-test",
      kind: "confirmation",
    });
    expect(pendingInteractions.get(capturedRequestId)).toBeDefined();

    controller.abort();
    const result = await resultPromise;
    expect(result.decision).toBe("deny");
    expect(pendingInteractions.get(capturedRequestId)).toBeUndefined();
  });

  test("resolveConfirmation removes the pending interaction entry", async () => {
    let capturedRequestId = "";
    const prompter = new PermissionPrompter((msg: any) => {
      if (msg.requestId) capturedRequestId = msg.requestId;
    });
    prompter.setOnPromptReleased((requestId) => {
      pendingInteractions.drop(requestId);
    });

    const resultPromise = prompter.prompt(
      "test_tool",
      { cmd: "ls" },
      "low",
      [],
      [],
    );

    await new Promise((r) => setTimeout(r, 10));
    pendingInteractions.register(capturedRequestId, {
      conversation: null,
      conversationId: "conv-test",
      kind: "confirmation",
    });

    prompter.resolveConfirmation(capturedRequestId, "allow");
    const result = await resultPromise;
    expect(result.decision).toBe("allow");
    expect(pendingInteractions.get(capturedRequestId)).toBeUndefined();
  });

  test("dispose removes all pending interaction entries", async () => {
    const capturedIds: string[] = [];
    const prompter = new PermissionPrompter((msg: any) => {
      if (msg.requestId) capturedIds.push(msg.requestId);
    });
    prompter.setOnPromptReleased((requestId) => {
      pendingInteractions.drop(requestId);
    });

    // Start two prompts
    const p1 = prompter
      .prompt("tool1", {}, "low", [], [])
      .catch(() => ({ decision: "deny" as const }));
    const p2 = prompter
      .prompt("tool2", {}, "low", [], [])
      .catch(() => ({ decision: "deny" as const }));

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedIds).toHaveLength(2);

    for (const id of capturedIds) {
      pendingInteractions.register(id, {
        conversation: null,
        conversationId: "conv-test",
        kind: "confirmation",
      });
    }

    prompter.dispose();
    await Promise.allSettled([p1, p2]);

    for (const id of capturedIds) {
      expect(pendingInteractions.get(id)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// SecretPrompter cleanup
// ---------------------------------------------------------------------------

describe("SecretPrompter + pending-interactions cleanup", () => {
  test("secret timeout removes the pending interaction entry", async () => {
    let capturedRequestId = "";
    const prompter = new SecretPrompter((msg: any) => {
      if (msg.requestId) capturedRequestId = msg.requestId;
    });
    prompter.setOnPromptReleased((requestId) => {
      pendingInteractions.drop(requestId);
    });

    const resultPromise = prompter.prompt("api", "key", "API Key");

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedRequestId).not.toBe("");
    pendingInteractions.register(capturedRequestId, {
      conversation: null,
      conversationId: "conv-test",
      kind: "secret",
    });

    const result = await resultPromise;
    expect(result.value).toBeNull();
    expect(pendingInteractions.get(capturedRequestId)).toBeUndefined();
  });

  test("resolveSecret removes the pending interaction entry", async () => {
    let capturedRequestId = "";
    const prompter = new SecretPrompter((msg: any) => {
      if (msg.requestId) capturedRequestId = msg.requestId;
    });
    prompter.setOnPromptReleased((requestId) => {
      pendingInteractions.drop(requestId);
    });

    const resultPromise = prompter.prompt("api", "key", "API Key");

    await new Promise((r) => setTimeout(r, 10));
    pendingInteractions.register(capturedRequestId, {
      conversation: null,
      conversationId: "conv-test",
      kind: "secret",
    });

    prompter.resolveSecret(capturedRequestId, "the-secret", "store");
    const result = await resultPromise;
    expect(result.value).toBe("the-secret");
    expect(pendingInteractions.get(capturedRequestId)).toBeUndefined();
  });

  test("dispose removes all pending secret interaction entries", async () => {
    const capturedIds: string[] = [];
    const prompter = new SecretPrompter((msg: any) => {
      if (msg.requestId) capturedIds.push(msg.requestId);
    });
    prompter.setOnPromptReleased((requestId) => {
      pendingInteractions.drop(requestId);
    });

    const p1 = prompter
      .prompt("api", "key1", "Key 1")
      .catch(() => ({ value: null, delivery: "store" as const }));
    const p2 = prompter
      .prompt("api", "key2", "Key 2")
      .catch(() => ({ value: null, delivery: "store" as const }));

    await new Promise((r) => setTimeout(r, 10));

    for (const id of capturedIds) {
      pendingInteractions.register(id, {
        conversation: null,
        conversationId: "conv-test",
        kind: "secret",
      });
    }

    prompter.dispose();
    await Promise.allSettled([p1, p2]);

    for (const id of capturedIds) {
      expect(pendingInteractions.get(id)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// dropByConversationId with host-tool entries
// ---------------------------------------------------------------------------

describe("dropByConversationId for conversation disposal", () => {
  test("drops host_bash, host_file, host_cu, and confirmation entries when includeHostTools is true but preserves acp_confirmation", () => {
    pendingInteractions.register("req-conf", {
      conversation: null,
      conversationId: "conv-dispose",
      kind: "confirmation",
    });
    pendingInteractions.register("req-secret", {
      conversation: null,
      conversationId: "conv-dispose",
      kind: "secret",
    });
    pendingInteractions.register("req-bash", {
      conversation: null,
      conversationId: "conv-dispose",
      kind: "host_bash",
    });
    pendingInteractions.register("req-file", {
      conversation: null,
      conversationId: "conv-dispose",
      kind: "host_file",
    });
    pendingInteractions.register("req-cu", {
      conversation: null,
      conversationId: "conv-dispose",
      kind: "host_cu",
    });
    pendingInteractions.register("req-acp", {
      conversation: null,
      conversationId: "conv-dispose",
      kind: "acp_confirmation",
      directResolve: () => {},
    });

    pendingInteractions.dropByConversationId("conv-dispose", {
      includeHostTools: true,
    });

    expect(pendingInteractions.get("req-conf")).toBeUndefined();
    expect(pendingInteractions.get("req-secret")).toBeUndefined();
    expect(pendingInteractions.get("req-bash")).toBeUndefined();
    expect(pendingInteractions.get("req-file")).toBeUndefined();
    expect(pendingInteractions.get("req-cu")).toBeUndefined();
    // ACP confirmations are always preserved for the session manager
    expect(pendingInteractions.get("req-acp")).toBeDefined();
  });

  test("does not affect entries for other conversations", () => {
    pendingInteractions.register("req-keep", {
      conversation: null,
      conversationId: "conv-keep",
      kind: "host_bash",
    });
    pendingInteractions.register("req-drop", {
      conversation: null,
      conversationId: "conv-dispose",
      kind: "host_bash",
    });

    pendingInteractions.dropByConversationId("conv-dispose", {
      includeHostTools: true,
    });

    expect(pendingInteractions.get("req-keep")).toBeDefined();
    expect(pendingInteractions.get("req-drop")).toBeUndefined();
  });
});
