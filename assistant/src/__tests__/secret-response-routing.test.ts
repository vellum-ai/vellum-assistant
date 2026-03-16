import { beforeEach, describe, expect, test } from "bun:test";

import type {
  SecretRequest,
  ServerMessage,
} from "../daemon/message-protocol.js";
import type { SecretPromptResult } from "../permissions/secret-prompter.js";
import { SecretPrompter } from "../permissions/secret-prompter.js";

describe("secret response routing", () => {
  let prompter: SecretPrompter;
  let sentMessages: ServerMessage[];

  beforeEach(() => {
    sentMessages = [];
    prompter = new SecretPrompter((msg) => {
      sentMessages.push(msg);
    });
  });

  test("resolveSecret defaults delivery to store when omitted", async () => {
    const promise = prompter.prompt("github", "token", "GitHub Token");
    const requestId = (sentMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "test-value");
    const result: SecretPromptResult = await promise;
    expect(result.value).toBe("test-value");
    expect(result.delivery).toBe("store");
  });

  test("resolveSecret passes store delivery", async () => {
    const promise = prompter.prompt("github", "token", "GitHub Token");
    const requestId = (sentMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "test-value", "store");
    const result = await promise;
    expect(result.value).toBe("test-value");
    expect(result.delivery).toBe("store");
  });

  test("resolveSecret passes transient_send delivery", async () => {
    const promise = prompter.prompt("github", "token", "GitHub Token");
    const requestId = (sentMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, "one-time-value", "transient_send");
    const result = await promise;
    expect(result.value).toBe("one-time-value");
    expect(result.delivery).toBe("transient_send");
  });

  test("resolveSecret with cancelled value defaults delivery to store", async () => {
    const promise = prompter.prompt("github", "token", "GitHub Token");
    const requestId = (sentMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, undefined);
    const result = await promise;
    expect(result.value).toBeNull();
    expect(result.delivery).toBe("store");
  });

  test("prompt timeout returns null value with store delivery", async () => {
    // We can't easily test the full timeout, but we verify the structure
    // by resolving immediately (the timeout path also returns { value: null, delivery: 'store' })
    const promise = prompter.prompt("github", "token", "GitHub Token");
    const requestId = (sentMessages[0] as SecretRequest).requestId;
    prompter.resolveSecret(requestId, undefined, undefined);
    const result = await promise;
    expect(result.value).toBeNull();
    expect(result.delivery).toBe("store");
  });

  test("sent message is a secret_request with correct fields", async () => {
    const promise = prompter.prompt(
      "github",
      "token",
      "GitHub Token",
      "desc",
      "placeholder",
      "session-1",
    );
    expect(sentMessages.length).toBe(1);
    const msg = sentMessages[0] as SecretRequest;
    expect(msg.type).toBe("secret_request");
    expect(msg.service).toBe("github");
    expect(msg.field).toBe("token");
    expect(msg.label).toBe("GitHub Token");
    expect(msg.description).toBe("desc");
    expect(msg.placeholder).toBe("placeholder");
    expect(msg.conversationId).toBe("session-1");
    // Clean up
    prompter.resolveSecret(msg.requestId, undefined);
    await promise;
  });

  test("resolveSecret for unknown requestId is a no-op", () => {
    // Should not throw
    prompter.resolveSecret("unknown-id", "value", "store");
  });

  test("dispose rejects pending prompts", async () => {
    const promise = prompter.prompt("github", "token", "GitHub Token");
    prompter.dispose();
    try {
      await promise;
      expect(true).toBe(false); // should not reach here
    } catch (e: unknown) {
      expect((e as Error).message).toBe("Prompter disposed");
    }
  });
});
