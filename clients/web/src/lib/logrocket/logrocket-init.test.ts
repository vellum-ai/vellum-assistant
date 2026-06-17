import { describe, expect, mock, test } from "bun:test";

// Avoid loading the real LogRocket UMD bundle (and the store/device-settings
// dependencies it pulls in) when importing the init module under test.
mock.module("logrocket", () => ({
  default: { init: () => {}, identify: () => {} },
}));
mock.module("@/lib/logrocket/logrocket-control", () => ({
  installLogRocketControlListeners: () => () => {},
  logRocketConsentGranted: () => false,
  syncLogRocketClient: () => {},
}));

const { requestSanitizer, responseSanitizer } = await import(
  "@/lib/logrocket/logrocket-init"
);

const REDACTED = "[REDACTED]";

describe("requestSanitizer", () => {
  test("redacts credential headers and token-shaped body fields, sanitizes the url", () => {
    const out = requestSanitizer({
      reqId: "1",
      method: "POST",
      url: "https://api.vellum.ai/v1/oauth/callback?code=abc123&keep=ok",
      headers: {
        Authorization: "Bearer secret-token",
        Cookie: "sessionid=xyz",
        "X-Api-Key": "k-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "alice",
        password: "hunter2",
        access_token: "tok-abc",
        nested: { refresh_token: "r-1", note: "keep" },
      }),
    });

    // URL: the `code` auth param is scrubbed, the benign one preserved.
    expect(out.url).toContain("code=%5BREDACTED%5D");
    expect(out.url).toContain("keep=ok");

    // Headers: credentials redacted, benign header preserved.
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers.Cookie).toBe(REDACTED);
    expect(out.headers["X-Api-Key"]).toBe(REDACTED);
    expect(out.headers["Content-Type"]).toBe("application/json");

    // Body: token-shaped fields redacted (incl. nested), benign fields kept.
    const body = JSON.parse(out.body!);
    expect(body.username).toBe("alice");
    expect(body.password).toBe(REDACTED);
    expect(body.access_token).toBe(REDACTED);
    expect(body.nested.refresh_token).toBe(REDACTED);
    expect(body.nested.note).toBe("keep");
  });

  test("leaves a non-JSON body untouched", () => {
    const out = requestSanitizer({
      reqId: "2",
      method: "GET",
      url: "https://api.vellum.ai/v1/feed",
      headers: {},
      body: "not json",
    });
    expect(out.body).toBe("not json");
  });
});

describe("responseSanitizer", () => {
  test("redacts credential headers and token-shaped body fields", () => {
    const out = responseSanitizer({
      reqId: "3",
      method: "POST",
      status: 200,
      url: "https://api.vellum.ai/v1/oauth/token?token=leak",
      headers: { "Set-Cookie": "sessionid=xyz", "X-Trace": "ok" },
      body: JSON.stringify({ id_token: "jwt", ok: true }),
    });

    expect(out.url).toContain("token=%5BREDACTED%5D");
    expect(out.headers["Set-Cookie"]).toBe(REDACTED);
    expect(out.headers["X-Trace"]).toBe("ok");

    const body = JSON.parse(out.body!);
    expect(body.id_token).toBe(REDACTED);
    expect(body.ok).toBe(true);
  });
});
