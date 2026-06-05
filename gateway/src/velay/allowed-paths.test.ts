import { describe, expect, it } from "bun:test";

import {
  VELAY_ALLOWED_PATHS,
  VELAY_ALLOWED_PATHS_HEADER,
  VELAY_ALLOWED_PATHS_HEADER_VALUE,
} from "./allowed-paths.js";

describe("VELAY_ALLOWED_PATHS", () => {
  it("matches the platform-side header name (must stay in sync with vellum-assistant-platform RegistrationAllowedPathsHeader)", () => {
    expect(VELAY_ALLOWED_PATHS_HEADER).toBe("X-Vellum-Velay-Allowed-Paths");
  });

  it("encodes the regex list as a JSON array string for direct use as the header value", () => {
    expect(VELAY_ALLOWED_PATHS_HEADER_VALUE).toBe(
      JSON.stringify(VELAY_ALLOWED_PATHS),
    );
    const decoded = JSON.parse(VELAY_ALLOWED_PATHS_HEADER_VALUE) as unknown;
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toEqual([...VELAY_ALLOWED_PATHS]);
  });

  it("contains only RE2-portable regex patterns (no JS-specific lookaround / backreferences) that compile in JavaScript too", () => {
    // We can't run Go RE2 here, but every pattern below is plain anchored
    // prefix/exact matching that's a strict subset of both engines.
    for (const pattern of VELAY_ALLOWED_PATHS) {
      expect(() => new RegExp(pattern)).not.toThrow();
      // RE2-incompatible features that should never appear: lookahead,
      // lookbehind, backreferences. A simple guard is enough — the platform
      // side will reject anything Go's regexp.Compile can't parse.
      expect(pattern).not.toMatch(/\(\?[=!<]/); // lookaround
      expect(pattern).not.toMatch(/\\[1-9]/); // backreferences
    }
  });

  it("matches the four gateway public-surface route shapes", () => {
    // Allowlist coverage check — if you add a public route in
    // `gateway/src/index.ts` that needs to be reachable through the Velay
    // tunnel, add a matching regex to VELAY_ALLOWED_PATHS and a sample here.
    const samples = {
      "/webhooks/telegram": true,
      "/webhooks/twilio/voice": true,
      "/webhooks/twilio/status": true,
      "/webhooks/twilio/voice-verify": true,
      "/webhooks/whatsapp": true,
      "/webhooks/email": true,
      "/webhooks/resend": true,
      "/webhooks/mailgun": true,
      "/webhooks/oauth/callback": true,
      "/v1/audio/some-uuid.mp3": true,
      "/v1/live-voice": true,
      "/v1/stt/stream": true,
      // Negative samples — paths that must NOT be tunnel-public.
      "/v1/contacts/abc": false,
      "/v1/health": false,
      "/v1/pair": false,
      "/v1/guardian/init": false,
      "/internal/admin": false,
      "/secret": false,
      "": false,
    };
    const compiled = VELAY_ALLOWED_PATHS.map((p) => new RegExp(p));
    for (const [path, expected] of Object.entries(samples)) {
      const matched = compiled.some((re) => re.test(path));
      expect({ path, matched }).toEqual({ path, matched: expected });
    }
  });
});
