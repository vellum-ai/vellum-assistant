/**
 * End-to-end A2A channel integration tests.
 *
 * Tests the assistant-side A2A lifecycle: connection initiation, task store +
 * delivery adapter flow, ACL enforcement via trusted contacts, push
 * notifications, and the feature toggle.
 *
 * Because the gateway and assistant are separate processes, we test the
 * assistant-side integration with mocked HTTP for inter-gateway calls and
 * mocked config for feature flag checks.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChannelReplyPayload } from "@vellumai/gateway-client";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchResponseMap: Record<
  string,
  { ok: boolean; status: number; body: string }
> = {};
let defaultFetchResponse = { ok: true, status: 200, body: "{}" };

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing modules under test
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

// The config-a2a handler uses these config functions directly (not mocked via
// module replacement) because it calls loadRawConfig/saveRawConfig to toggle
// the a2a.enabled flag. We use the real config system backed by initializeDb's
// workspace directory.

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import {
  findContactByAddress,
  upsertContact,
} from "../../contacts/contact-store.js";
import {
  clearA2AConfig,
  getA2AConfig,
  setA2AConfig,
} from "../../daemon/handlers/config-a2a.js";
import { getSqlite } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import type { A2AMessage, Artifact } from "../protocol-types.js";
import {
  completeWithArtifacts,
  createTask,
  getPushUrl,
  getTask,
  updateState,
} from "../task-store.js";

initializeDb();

// ---------------------------------------------------------------------------
// Global fetch intercept
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM a2a_tasks");
  sqlite.run("DELETE FROM assistant_contact_metadata");
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function setConfigEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "a2a.enabled", enabled);
  setNestedValue(raw, "ingress.publicBaseUrl", "https://self.example.com");
  saveRawConfig(raw);
  invalidateConfigCache();
}

function makeRequestMessage(overrides?: Partial<A2AMessage>): A2AMessage {
  return {
    message_id: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: "Hello from sender" }],
    ...overrides,
  };
}

function installFetchMock(): void {
  fetchCalls.length = 0;
  fetchResponseMap = {};
  defaultFetchResponse = { ok: true, status: 200, body: "{}" };

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init: init ?? {} });

    // Check for URL-specific responses
    for (const [pattern, response] of Object.entries(fetchResponseMap)) {
      if (url.includes(pattern)) {
        return new Response(response.body, {
          status: response.status,
          statusText: response.ok ? "OK" : "Error",
        });
      }
    }

    return new Response(defaultFetchResponse.body, {
      status: defaultFetchResponse.status,
      statusText: defaultFetchResponse.ok ? "OK" : "Error",
    });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetTables();
  setConfigEnabled(false);
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ===========================================================================
// Test: trusted contact setup (platform-mediated)
// ===========================================================================

describe("e2e: trusted contact setup", () => {
  test("upsertContact creates a2a channel for assistant contact", () => {
    setConfigEnabled(true);

    upsertContact({
      displayName: "Peer Assistant",
      contactType: "assistant",
      role: "contact",
      channels: [
        {
          type: "a2a",
          address: "assistant-b",
          externalUserId: "assistant-b",
          status: "active",
          policy: "allow",
        },
      ],
    });

    const contact = findContactByAddress("a2a", "assistant-b");
    expect(contact).not.toBeNull();
    expect(contact!.channels.some((ch) => ch.type === "a2a")).toBe(true);
    const a2aChannel = contact!.channels.find((ch) => ch.type === "a2a");
    expect(a2aChannel!.status).toBe("active");
    expect(a2aChannel!.address).toBe("assistant-b");
  });
});

// ===========================================================================
// Test: message after trusted contact established
// ===========================================================================

describe("e2e: message delivery after trusted contact established", () => {
  test("task store lifecycle: create -> working -> complete with artifacts", () => {
    // Create a task as if an inbound A2A message arrived
    const msg = makeRequestMessage({
      parts: [{ kind: "text", text: "Order a coffee for me" }],
    });

    const task = createTask({
      senderAssistantId: "assistant-a",
      requestMessage: msg,
      pushUrl: "https://requester.example.com/a2a/push",
    });

    expect(task.status.state).toBe("submitted");

    // Transition to working
    const working = updateState(task.id, "working", "Processing request...");
    expect(working.status.state).toBe("working");

    // Complete with artifacts (simulating the assistant's response)
    const artifacts: Artifact[] = [
      {
        artifact_id: crypto.randomUUID(),
        parts: [{ kind: "text", text: "I'll have a latte" }],
      },
    ];
    const completed = completeWithArtifacts(task.id, artifacts);

    expect(completed.status.state).toBe("completed");
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts![0].parts[0]).toEqual({
      kind: "text",
      text: "I'll have a latte",
    });

    // Verify via fresh getTask
    const fetched = getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status.state).toBe("completed");
    expect(fetched!.artifacts).toEqual(completed.artifacts);

    // Push URL is stored and retrievable
    const pushUrl = getPushUrl(task.id);
    expect(pushUrl).toBe("https://requester.example.com/a2a/push");
  });

  test("delivery adapter completes task and triggers push notification", async () => {
    // Create a task that simulates an inbound A2A request
    const task = createTask({
      senderAssistantId: "assistant-a",
      requestMessage: makeRequestMessage(),
      pushUrl: "https://requester.example.com/a2a/push",
    });

    // Move to working state (as the runtime would)
    updateState(task.id, "working");

    // Import the delivery adapter
    const { deliverA2AReply } =
      await import("../../messaging/providers/a2a/deliver.js");

    // Simulate the assistant's response via the delivery adapter
    const payload: ChannelReplyPayload = {
      chatId: "chat-1",
      text: "I'll have a latte",
    };

    const callbackUrl = `https://example.com/deliver/a2a?taskId=${task.id}`;
    const result = await deliverA2AReply(callbackUrl, payload);

    expect(result.ok).toBe(true);

    // Task should be completed in the store
    const completedTask = getTask(task.id);
    expect(completedTask).not.toBeNull();
    expect(completedTask!.status.state).toBe("completed");
    expect(completedTask!.artifacts).toHaveLength(1);
    expect(completedTask!.artifacts![0].parts[0]).toEqual({
      kind: "text",
      text: "I'll have a latte",
    });

    // Wait for the fire-and-forget push notification
    await new Promise((r) => setTimeout(r, 100));

    // Verify push notification was sent
    const pushCall = fetchCalls.find((c) =>
      c.url.includes("requester.example.com/a2a/push"),
    );
    expect(pushCall).toBeTruthy();
    expect(pushCall!.init.method).toBe("POST");

    const headers = pushCall!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/a2a+json");
    expect(headers["A2A-Version"]).toBe("1.0");

    // Push body should contain the completed task
    const pushBody = JSON.parse(pushCall!.init.body as string);
    expect(pushBody.status.state).toBe("completed");
    expect(pushBody.artifacts).toHaveLength(1);
  });
});

// ===========================================================================
// Test: disabled channel
// ===========================================================================

describe("e2e: disabled channel", () => {
  test("getA2AConfig returns disabled when a2a.enabled is false", () => {
    const result = getA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
  });

  test("clearA2AConfig disables the channel", () => {
    setConfigEnabled(true);
    const before = getA2AConfig();
    expect(before.enabled).toBe(true);

    const result = clearA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);

    const after = getA2AConfig();
    expect(after.enabled).toBe(false);
  });

  test("setA2AConfig enables the channel and clearA2AConfig disables it", () => {
    // Start disabled
    expect(getA2AConfig().enabled).toBe(false);

    // Enable
    setA2AConfig();
    expect(getA2AConfig().enabled).toBe(true);

    // Disable
    clearA2AConfig();
    expect(getA2AConfig().enabled).toBe(false);
  });
});

// ===========================================================================
// Test: unknown sender blocked
// ===========================================================================

describe("e2e: unknown sender blocked (ACL enforcement)", () => {
  test("no trusted contact exists for the sender assistant", () => {
    // Verify there is no contact for the unknown sender
    const contact = findContactByAddress("a2a", "unknown-assistant");
    expect(contact).toBeNull();

    // Create a task from the unknown sender (as the gateway would)
    const msg = makeRequestMessage({
      parts: [{ kind: "text", text: "Hey, do something for me" }],
    });
    const task = createTask({
      senderAssistantId: "unknown-assistant",
      requestMessage: msg,
    });

    // The task is created (the gateway always creates a task), but
    // the runtime's ACL check would reject it because there is no
    // trusted contact_channel for "unknown-assistant".
    expect(task.status.state).toBe("submitted");

    // The ACL layer performs findContactByAddress to resolve trust.
    // For an unknown sender, this returns null — blocking the message.
    const senderContact = findContactByAddress("a2a", "unknown-assistant");
    expect(senderContact).toBeNull();
  });

  test("trusted contact exists with active a2a channel — ACL passes", async () => {
    const { upsertContact } = await import("../../contacts/contact-store.js");

    // Pre-create a trusted contact for the sender
    upsertContact({
      displayName: "Trusted Bot",
      contactType: "assistant",
      role: "contact",
      channels: [
        {
          type: "a2a",
          address: "trusted-assistant",
          externalUserId: "trusted-assistant",
          status: "active",
          policy: "allow",
        },
      ],
    });

    // Verify the contact exists (the ACL check the runtime performs)
    const contact = findContactByAddress("a2a", "trusted-assistant");
    expect(contact).not.toBeNull();

    const a2aChannel = contact!.channels.find((ch) => ch.type === "a2a");
    expect(a2aChannel).toBeTruthy();
    expect(a2aChannel!.status).toBe("active");
    expect(a2aChannel!.policy).toBe("allow");

    // A task from this sender would pass the ACL check
    const msg = makeRequestMessage();
    const task = createTask({
      senderAssistantId: "trusted-assistant",
      requestMessage: msg,
    });
    expect(task.status.state).toBe("submitted");
  });

  test("contact exists but channel is blocked — ACL would reject", async () => {
    const { upsertContact } = await import("../../contacts/contact-store.js");

    upsertContact({
      displayName: "Blocked Bot",
      contactType: "assistant",
      role: "contact",
      channels: [
        {
          type: "a2a",
          address: "blocked-assistant",
          externalUserId: "blocked-assistant",
          status: "blocked",
          policy: "deny",
        },
      ],
    });

    const contact = findContactByAddress("a2a", "blocked-assistant");
    expect(contact).not.toBeNull();

    const a2aChannel = contact!.channels.find((ch) => ch.type === "a2a");
    expect(a2aChannel!.status).toBe("blocked");
    expect(a2aChannel!.policy).toBe("deny");
  });
});

// ===========================================================================
// Test: push notification failure gracefully degrades
// ===========================================================================

describe("e2e: push notification failure graceful degradation", () => {
  test("task completes even when push URL returns 500", async () => {
    // Set up a task with a push URL that will fail
    const task = createTask({
      senderAssistantId: "assistant-a",
      requestMessage: makeRequestMessage(),
      pushUrl: "https://failing-push.example.com/a2a/push",
    });
    updateState(task.id, "working");

    // Mock: all push requests fail with 500
    fetchResponseMap["failing-push.example.com"] = {
      ok: false,
      status: 500,
      body: "Internal Server Error",
    };

    const { deliverA2AReply } =
      await import("../../messaging/providers/a2a/deliver.js");

    const callbackUrl = `https://example.com/deliver/a2a?taskId=${task.id}`;
    const result = await deliverA2AReply(callbackUrl, {
      chatId: "chat-1",
      text: "Here is your response",
    });

    // Delivery still succeeds — push failure is fire-and-forget
    expect(result.ok).toBe(true);

    // Task is completed in the store regardless of push failure
    const completedTask = getTask(task.id);
    expect(completedTask).not.toBeNull();
    expect(completedTask!.status.state).toBe("completed");
    expect(completedTask!.artifacts).toHaveLength(1);
    expect(completedTask!.artifacts![0].parts[0]).toEqual({
      kind: "text",
      text: "Here is your response",
    });

    // Wait for push retry attempts to fully settle (3 retries with exponential backoff)
    await new Promise((r) => setTimeout(r, 10_000));

    // Push was attempted (initial + retries)
    const pushCalls = fetchCalls.filter((c) =>
      c.url.includes("failing-push.example.com"),
    );
    expect(pushCalls.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  test("task completes when no push URL is configured", async () => {
    const task = createTask({
      senderAssistantId: "assistant-a",
      requestMessage: makeRequestMessage(),
      // No pushUrl
    });
    updateState(task.id, "working");

    const { deliverA2AReply } =
      await import("../../messaging/providers/a2a/deliver.js");

    const callbackUrl = `https://example.com/deliver/a2a?taskId=${task.id}`;
    const result = await deliverA2AReply(callbackUrl, {
      chatId: "chat-1",
      text: "Response without push",
    });

    expect(result.ok).toBe(true);

    // No push URL means no fetch calls for push
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchCalls).toHaveLength(0);

    // Task is still completed
    const completedTask = getTask(task.id);
    expect(completedTask!.status.state).toBe("completed");
  });
});

// ===========================================================================
// Full round-trip: connect -> trusted contact -> send message -> response -> push
// ===========================================================================

describe("e2e: full A2A round-trip", () => {
  test("connect, establish trust, send message, deliver response, push notification", async () => {
    setConfigEnabled(true);

    // Step 1: Create trusted contact for Assistant B (platform-mediated)
    upsertContact({
      displayName: "Assistant B",
      contactType: "assistant",
      role: "contact",
      channels: [
        {
          type: "a2a",
          address: "assistant-b",
          externalUserId: "assistant-b",
          status: "active",
          policy: "allow",
        },
      ],
    });

    // Step 2: Verify trusted contact was created
    const contact = findContactByAddress("a2a", "assistant-b");
    expect(contact).not.toBeNull();
    expect(contact!.channels.find((ch) => ch.type === "a2a")!.status).toBe(
      "active",
    );

    // Step 3: Simulate inbound A2A message from B (as if B sent us a request)
    const inboundMsg = makeRequestMessage({
      parts: [{ kind: "text", text: "Can you help me with something?" }],
    });
    const task = createTask({
      senderAssistantId: "assistant-b",
      requestMessage: inboundMsg,
      pushUrl: "https://b.example.com/a2a/push",
    });

    expect(task.status.state).toBe("submitted");

    // ACL check: trusted contact exists
    const senderContact = findContactByAddress("a2a", "assistant-b");
    expect(senderContact).not.toBeNull();

    // Step 4: Runtime processes the task
    updateState(task.id, "working");

    // Step 5: Deliver the response via the delivery adapter
    // Clear previous fetch calls
    fetchCalls.length = 0;
    fetchResponseMap = {};
    defaultFetchResponse = { ok: true, status: 200, body: "{}" };

    const { deliverA2AReply } =
      await import("../../messaging/providers/a2a/deliver.js");

    const callbackUrl = `https://example.com/deliver/a2a?taskId=${task.id}`;
    const result = await deliverA2AReply(callbackUrl, {
      chatId: "chat-1",
      text: "Sure, I can help!",
    });

    expect(result.ok).toBe(true);

    // Step 6: Verify task completed with artifact
    const completedTask = getTask(task.id);
    expect(completedTask!.status.state).toBe("completed");
    expect(completedTask!.artifacts).toHaveLength(1);
    expect(completedTask!.artifacts![0].parts[0]).toEqual({
      kind: "text",
      text: "Sure, I can help!",
    });

    // Step 7: Verify push notification was sent to B
    await new Promise((r) => setTimeout(r, 100));

    const pushCall = fetchCalls.find((c) =>
      c.url.includes("b.example.com/a2a/push"),
    );
    expect(pushCall).toBeTruthy();
    expect(pushCall!.init.method).toBe("POST");

    const pushHeaders = pushCall!.init.headers as Record<string, string>;
    expect(pushHeaders["Content-Type"]).toBe("application/a2a+json");
    expect(pushHeaders["A2A-Version"]).toBe("1.0");

    const pushBody = JSON.parse(pushCall!.init.body as string);
    expect(pushBody.status.state).toBe("completed");
    expect(pushBody.artifacts).toHaveLength(1);
  });
});
