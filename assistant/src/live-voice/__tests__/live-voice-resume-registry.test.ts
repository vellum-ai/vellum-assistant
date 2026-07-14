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
  test("register makes a handler discoverable by conversation id", () => {
    const conversationId = `conv-${crypto.randomUUID()}`;
    const handler = makeHandler();

    expect(getVoiceResumeHandler(conversationId)).toBeUndefined();
    registerVoiceResumeHandler(conversationId, handler);
    expect(getVoiceResumeHandler(conversationId)).toBe(handler);

    unregisterVoiceResumeHandler(conversationId, handler);
  });

  test("register overwrites an existing handler for the same conversation", () => {
    const conversationId = `conv-${crypto.randomUUID()}`;
    const first = makeHandler();
    const second = makeHandler();

    registerVoiceResumeHandler(conversationId, first);
    registerVoiceResumeHandler(conversationId, second);
    expect(getVoiceResumeHandler(conversationId)).toBe(second);

    unregisterVoiceResumeHandler(conversationId, second);
  });

  test("unregister deletes only when the stored handler is the one passed", () => {
    const conversationId = `conv-${crypto.randomUUID()}`;
    const current = makeHandler();
    const stale = makeHandler();

    registerVoiceResumeHandler(conversationId, current);

    // A stale (older) session tearing down must not evict the current handler.
    unregisterVoiceResumeHandler(conversationId, stale);
    expect(getVoiceResumeHandler(conversationId)).toBe(current);

    // The owning handler's unregister clears it.
    unregisterVoiceResumeHandler(conversationId, current);
    expect(getVoiceResumeHandler(conversationId)).toBeUndefined();
  });
});
