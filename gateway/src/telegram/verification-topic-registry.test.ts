import { afterEach, describe, expect, test } from "bun:test";

import {
  forgetVerificationTopic,
  isVerificationTopic,
  rememberVerificationTopic,
  resetVerificationTopicRegistryForTesting,
} from "./verification-topic-registry.js";

afterEach(() => {
  resetVerificationTopicRegistryForTesting();
});

describe("verification-topic-registry", () => {
  test("matches a registered chat/thread pair until forgotten", () => {
    rememberVerificationTopic("chat-1", "777");
    expect(isVerificationTopic("chat-1", "777")).toBe(true);
    expect(isVerificationTopic("chat-1", "888")).toBe(false);
    forgetVerificationTopic("chat-1");
    expect(isVerificationTopic("chat-1", "777")).toBe(false);
  });

  test("replaces the thread id when the same chat registers again", () => {
    rememberVerificationTopic("chat-1", "111");
    rememberVerificationTopic("chat-1", "222");
    expect(isVerificationTopic("chat-1", "111")).toBe(false);
    expect(isVerificationTopic("chat-1", "222")).toBe(true);
  });
});
