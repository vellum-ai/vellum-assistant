import { describe, expect, it } from "bun:test";

import {
  VELAY_ALLOWED_PATHS,
  VELAY_ALLOWED_PATHS_HEADER,
  VELAY_ALLOWED_PATHS_HEADER_VALUE,
} from "./allowed-paths.js";
import { isAllowedVelayWebSocketPath } from "./bridge-utils.js";

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

  it("matches the gateway public-surface route shapes", () => {
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
      // Plugin-declared webhooks ride the existing `^/webhooks/` entry. Which
      // of them the gateway actually serves is decided by the approval gate,
      // not by Velay — the tunnel just stops treating the prefix as private.
      "/webhooks/plugins/example/realtime": true,
      "/v1/audio/some-uuid.mp3": true,
      "/v1/live-voice": true,
      "/v1/stt/stream": true,
      // Watch sessions on a managed assistant ride the tunnel, the same shape
      // as live voice: velay validates the browser's minted token on this path
      // and injects the attested caller, and the gateway's handler admits only
      // the guardian on it. Self-hosted assistants bypass velay entirely.
      "/v1/watch/stream": true,
      "/assistant/credentials/enter": true,
      "/v1/credential-requests/peek": true,
      "/v1/credential-requests/submit": true,
      // Negative samples — paths that must NOT be tunnel-public.
      "/v1/credential-requests": false,
      "/v1/credential-requests/other": false,
      "/assistant/credentials": false,
      "/assistant/settings/credentials": false,
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

/**
 * The two allowlists a tunnelled WebSocket has to clear, checked against each
 * other.
 *
 * `VELAY_ALLOWED_PATHS` is declared to velay at registration and enforced
 * platform-side; `VELAY_ALLOWED_WEBSOCKET_EXACT_PATHS` in `bridge-utils.ts` is
 * the local second layer, enforced when the bridge dials the gateway's own
 * loopback listener. A route needs both, and their comments have always said
 * to keep them in sync, but nothing checked it.
 *
 * That gap is not theoretical: `/v1/watch/stream` was added to the
 * registration list alone, and every managed watch session died at the bridge.
 * The bridge answers a path it does not recognize with a `websocket_open_error`
 * frame and no log, velay reports it as an opaque `tunnel_error`, and the
 * gateway records nothing at all — so the one place the omission could have
 * been noticed was a test like this one.
 */
describe("the registration allowlist and the bridge's WebSocket allowlist", () => {
  const WEBSOCKET_ROUTES = [
    "/v1/live-voice",
    "/v1/stt/stream",
    "/v1/watch/stream",
  ];

  it("admits every tunnelled WebSocket route at both layers", () => {
    const compiled = VELAY_ALLOWED_PATHS.map((p) => new RegExp(p));
    for (const path of WEBSOCKET_ROUTES) {
      expect({
        path,
        registration: compiled.some((re) => re.test(path)),
        bridge: isAllowedVelayWebSocketPath(path),
      }).toEqual({ path, registration: true, bridge: true });
    }
  });

  it("does not admit a WebSocket route at the bridge that velay would refuse", () => {
    // The reverse omission is quieter still: the bridge would dial happily and
    // velay would 404 the upgrade before the frame ever arrived.
    const compiled = VELAY_ALLOWED_PATHS.map((p) => new RegExp(p));
    for (const path of ["/v1/watch", "/v1/watch/stream/extra", "/v1/speech"]) {
      if (isAllowedVelayWebSocketPath(path)) {
        expect({
          path,
          registration: compiled.some((re) => re.test(path)),
        }).toEqual({ path, registration: true });
      }
    }
  });
});
