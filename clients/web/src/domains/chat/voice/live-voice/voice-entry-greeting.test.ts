/**
 * Tests for the "speak first" entry rule (JARVIS-1649).
 *
 * The rule is the whole module, so the tests are about the rule: a seed only
 * where it reads as an opener, and copy that actually resolves out of the
 * catalog rather than leaking a key path into someone's conversation.
 */

import { describe, expect, test } from "bun:test";

import { voiceEntryGreetingSeed } from "@/domains/chat/voice/live-voice/voice-entry-greeting";

describe("voiceEntryGreetingSeed", () => {
  test("seeds a turn on a conversation with nothing in it", () => {
    expect(voiceEntryGreetingSeed(true)).toBeString();
  });

  test("stays silent on a conversation already underway", () => {
    // The seed becomes a real user message. Sent into a live thread it is a
    // line the user never wrote, landing every time they open voice.
    expect(voiceEntryGreetingSeed(false)).toBeUndefined();
  });

  test("resolves real copy, not a key path", () => {
    // A missing catalog entry makes `t` echo the key, which would otherwise
    // ship "chat:voiceEntryGreeting.seed" to the assistant as a turn.
    const seed = voiceEntryGreetingSeed(true);
    expect(seed).not.toContain("voiceEntryGreeting");
    expect(seed).not.toContain(":");
    expect((seed ?? "").trim().length).toBeGreaterThan(0);
  });
});
