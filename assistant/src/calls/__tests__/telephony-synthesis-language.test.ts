/**
 * Telephony synthesis-language resolution.
 *
 * The pin half of this resolver is gated on whether the provider transcribing
 * the call honors manual language selection, so these cover which provider
 * that gate reads: the telephony role's, which is what the call dials.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { resolveTelephonySynthesisLanguage } from "../telephony-synthesis-language.js";

function seedStt(stt: Record<string, unknown>): void {
  setConfig("services", { stt });
}

afterEach(() => {
  setConfig("services", {});
});

describe("resolveTelephonySynthesisLanguage", () => {
  test("a detected caller language outranks the configured pin", () => {
    seedStt({ provider: "deepgram", language: "es" });

    expect(resolveTelephonySynthesisLanguage("hi-IN")).toBe("hi");
  });

  test("reads the pin gate from the telephony role, not the global provider", () => {
    // Whisper auto-detects and ignores services.stt.language, so reading the
    // global provider drops the pin. The call is transcribed by the telephony
    // role's deepgram, which is pinned to Hindi and honors it.
    seedStt({
      provider: "openai-whisper",
      language: "hi",
      roles: { telephony: { provider: "deepgram" } },
    });

    expect(resolveTelephonySynthesisLanguage()).toBe("hi");
  });

  test("a telephony role that auto-detects drops a pin the global would honor", () => {
    // The inverse: the global honors the pin but no call reaches it, so
    // hinting Hindi would contradict what the caller is actually heard by.
    seedStt({
      provider: "deepgram",
      language: "hi",
      roles: { telephony: { provider: "openai-whisper" } },
    });

    expect(resolveTelephonySynthesisLanguage()).toBeUndefined();
  });

  test("an unset telephony role reads the global provider", () => {
    seedStt({
      provider: "deepgram",
      language: "hi",
      roles: { liveVoice: { provider: "openai-whisper" } },
    });

    expect(resolveTelephonySynthesisLanguage()).toBe("hi");
  });

  test('"multi" is auto-detection, not a pin', () => {
    seedStt({
      provider: "openai-whisper",
      language: "multi",
      roles: { telephony: { provider: "deepgram" } },
    });

    expect(resolveTelephonySynthesisLanguage()).toBeUndefined();
  });

  test("no configured language yields no hint", () => {
    seedStt({
      provider: "openai-whisper",
      roles: { telephony: { provider: "deepgram" } },
    });

    expect(resolveTelephonySynthesisLanguage()).toBeUndefined();
  });
});
