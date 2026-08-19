import { beforeEach, describe, expect, it, mock } from "bun:test";

let velayWebhooksEnabled = false;

mock.module("../feature-flag-resolver.js", () => ({
  isFeatureFlagEnabled: (flag: string) =>
    flag === "velay-webhooks" ? velayWebhooksEnabled : false,
}));

const {
  VELAY_ALLOWED_PATHS,
  VELAY_ALLOWED_PATHS_HEADER,
  VELAY_ALLOWED_PATHS_HEADER_VALUE,
  VELAY_STATIC_ALLOWED_PATHS,
  buildVelayAllowedPathsHeaderValue,
} = await import("./allowed-paths.js");

function decode(headerValue: string): string[] {
  return JSON.parse(headerValue) as string[];
}

beforeEach(() => {
  velayWebhooksEnabled = false;
});

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
    velayWebhooksEnabled = true;
    const patterns = [
      ...VELAY_ALLOWED_PATHS,
      ...decode(
        buildVelayAllowedPathsHeaderValue([
          "/webhooks/plugins/example/realtime",
          "/webhooks/plugins/ex.am+ple/(realtime)",
        ]),
      ),
    ];
    for (const pattern of patterns) {
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

describe("buildVelayAllowedPathsHeaderValue", () => {
  it("advertises the legacy list verbatim while the flag is off", () => {
    expect(buildVelayAllowedPathsHeaderValue([])).toBe(
      VELAY_ALLOWED_PATHS_HEADER_VALUE,
    );
    expect(buildVelayAllowedPathsHeaderValue(["/webhooks/telegram"])).toBe(
      VELAY_ALLOWED_PATHS_HEADER_VALUE,
    );
  });

  it("drops the webhook wildcard for the statics plus one exact rule per registered path", () => {
    velayWebhooksEnabled = true;

    const rules = decode(
      buildVelayAllowedPathsHeaderValue([
        "/webhooks/telegram",
        "/webhooks/plugins/example/realtime",
      ]),
    );

    expect(rules).toEqual([
      ...VELAY_STATIC_ALLOWED_PATHS,
      "^/webhooks/telegram$",
      "^/webhooks/plugins/example/realtime$",
    ]);
    expect(rules).not.toContain("^/webhooks/");
    // The Twilio subtree keeps its prefix rule because its paths carry call
    // state the registry cannot hold.
    expect(rules).toContain("^/webhooks/twilio/");
  });

  it("advertises only the statics when nothing is registered", () => {
    velayWebhooksEnabled = true;

    expect(decode(buildVelayAllowedPathsHeaderValue([]))).toEqual([
      ...VELAY_STATIC_ALLOWED_PATHS,
    ]);
  });

  it("escapes regex metacharacters so a generated rule matches only its own path", () => {
    velayWebhooksEnabled = true;
    const path = "/webhooks/plugins/a.b+c*d?e|f(g)h[i]j{k}^l$m\\n";

    const rules = decode(buildVelayAllowedPathsHeaderValue([path]));
    const generated = rules[rules.length - 1];
    const compiled = new RegExp(generated);

    expect(compiled.test(path)).toBe(true);
    expect(compiled.test("/webhooks/plugins/aXbXcXdXeXfXgXhXiXjXkXlXmXn")).toBe(
      false,
    );
    expect(compiled.test(`${path}/extra`)).toBe(false);
    expect(compiled.test(`/prefix${path}`)).toBe(false);
  });
});
