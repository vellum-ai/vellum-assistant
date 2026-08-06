import { describe, expect, test } from "bun:test";

import { SttError } from "../../stt/types.js";
import { describeSttFailure } from "../voice-error-copy.js";

describe("describeSttFailure", () => {
  describe("BYOK providers (no userFacing marker)", () => {
    test("auth failure points the user at the provider API key", () => {
      const copy = describeSttFailure(
        new SttError(
          "auth",
          'Deepgram API error (401): {"err":"INVALID_AUTH"}',
        ),
        "deepgram",
      );
      // Raw upstream JSON never leaks; friendly copy names the key + provider.
      expect(copy).not.toContain("{");
      expect(copy).not.toContain("INVALID_AUTH");
      expect(copy).toContain("API key");
      expect(copy).toContain("Settings → Voice");
      expect(copy).toContain("Deepgram");
    });

    test("provider-error is generic and names the provider", () => {
      const copy = describeSttFailure(
        new SttError("provider-error", "connection reset by peer"),
        "openai-whisper",
      );
      expect(copy).not.toContain("connection reset by peer");
      expect(copy).toContain("OpenAI Whisper");
    });

    test("timeout uses provider-agnostic copy", () => {
      const copy = describeSttFailure(
        new SttError("timeout", "The operation was aborted"),
        "vellum",
      );
      // A managed timeout (AbortError) carries no marker, so it still gets the
      // friendly copy rather than the raw abort string.
      expect(copy).toBe("Transcription timed out.");
    });

    test("unknown provider falls back to a generic label", () => {
      const copy = describeSttFailure(
        new SttError("rate-limit", "429 Too Many Requests"),
        undefined,
      );
      expect(copy).toContain("the speech-to-text provider");
      expect(copy).not.toContain("429");
    });
  });

  describe("managed speech (userFacing marker)", () => {
    test("auth failure surfaces the reconnect remediation verbatim", () => {
      const message =
        "Managed speech needs a working Vellum platform connection — reconnect with 'assistant platform connect'.";
      const copy = describeSttFailure(
        new SttError("auth", message, { userFacing: true }),
        "vellum",
      );
      // The BYOK "check your API key in Settings → Voice" rewrite must not
      // clobber managed remediation — managed users hold no speech key.
      expect(copy).toBe(message);
      expect(copy).not.toContain("API key");
      expect(copy).not.toContain("Settings → Voice");
    });

    test("credits-exhausted message survives the provider-error branch", () => {
      const message =
        "Vellum credits are exhausted — add funds to your Vellum account to continue using managed transcription.";
      const copy = describeSttFailure(
        new SttError("provider-error", message, { userFacing: true }),
        "vellum",
      );
      expect(copy).toBe(message);
      expect(copy).not.toContain("returned an error while transcribing");
    });

    test("passthrough does not depend on the provider label", () => {
      const message = "Managed speech relay error: upstream_error";
      const copy = describeSttFailure(
        new SttError("provider-error", message, { userFacing: true }),
        undefined,
      );
      expect(copy).toBe(message);
    });
  });
});
