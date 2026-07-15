import { describe, expect, test } from "bun:test";

import {
  getVoiceResumeHandler,
  registerVoiceResumeHandler,
  unregisterVoiceResumeHandler,
  type VoiceResumeHandler,
} from "../live-voice-resume-registry.js";

function makeHandler(): VoiceResumeHandler {
  return { resumeWithText: () => {} };
}

describe("live-voice resume registry", () => {
  test("register then get returns the handler", () => {
    const conversationId = `conv-${Math.random()}`;
    const handler = makeHandler();
    registerVoiceResumeHandler(conversationId, handler);
    expect(getVoiceResumeHandler(conversationId)).toBe(handler);
    unregisterVoiceResumeHandler(conversationId, handler);
  });

  test("returns undefined for an unknown conversation", () => {
    expect(getVoiceResumeHandler(`conv-${Math.random()}`)).toBeUndefined();
  });

  test("register overwrites an existing handler for the same conversation", () => {
    const conversationId = `conv-${Math.random()}`;
    const first = makeHandler();
    const second = makeHandler();
    registerVoiceResumeHandler(conversationId, first);
    registerVoiceResumeHandler(conversationId, second);
    expect(getVoiceResumeHandler(conversationId)).toBe(second);
    unregisterVoiceResumeHandler(conversationId, second);
  });

  test("unregister removes only the current handler", () => {
    const conversationId = `conv-${Math.random()}`;
    const handler = makeHandler();
    registerVoiceResumeHandler(conversationId, handler);
    unregisterVoiceResumeHandler(conversationId, handler);
    expect(getVoiceResumeHandler(conversationId)).toBeUndefined();
  });

  test("identity-checked unregister: a stale handler does not evict a newer one", () => {
    const conversationId = `conv-${Math.random()}`;
    const stale = makeHandler();
    const current = makeHandler();
    registerVoiceResumeHandler(conversationId, stale);
    // A newer session adopts the same conversationId.
    registerVoiceResumeHandler(conversationId, current);
    // The stale session tears down; it must not remove the newer handler.
    unregisterVoiceResumeHandler(conversationId, stale);
    expect(getVoiceResumeHandler(conversationId)).toBe(current);
    unregisterVoiceResumeHandler(conversationId, current);
    expect(getVoiceResumeHandler(conversationId)).toBeUndefined();
  });
});
