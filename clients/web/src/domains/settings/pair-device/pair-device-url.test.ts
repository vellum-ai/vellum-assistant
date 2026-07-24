import { describe, expect, test } from "bun:test";

import {
  buildRemoteWebPairingUrl,
  isLoopbackUrl,
  normalizePublicBaseUrl,
  publicBaseUrlRejectionMessage,
  resolvePublicBaseUrl,
} from "./pair-device-url";

describe("normalizePublicBaseUrl", () => {
  test("strips query, hash, and the assistant path segment", () => {
    expect(
      normalizePublicBaseUrl(
        "https://foo.ts.net/assistant/pair?x=1#device_code=abc",
      ),
    ).toBe("https://foo.ts.net");
  });

  test("preserves a deployment path prefix before /assistant", () => {
    expect(
      normalizePublicBaseUrl("https://foo.example.com/vellum/assistant/"),
    ).toBe("https://foo.example.com/vellum");
  });

  test("trims trailing slashes", () => {
    expect(normalizePublicBaseUrl("https://foo.ts.net///")).toBe(
      "https://foo.ts.net",
    );
  });

  test("throws on an unparseable value", () => {
    expect(() => normalizePublicBaseUrl("not a url")).toThrow();
  });
});

describe("isLoopbackUrl", () => {
  test("flags localhost, 127.x, and ::1", () => {
    expect(isLoopbackUrl("https://localhost")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:7830")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:7830")).toBe(true);
  });

  test("passes a public host", () => {
    expect(isLoopbackUrl("https://foo.ts.net")).toBe(false);
  });
});

describe("resolvePublicBaseUrl", () => {
  test("accepts a public https URL and returns the normalized origin", () => {
    expect(resolvePublicBaseUrl("https://foo.ts.net/assistant#x")).toEqual({
      ok: true,
      url: "https://foo.ts.net",
    });
  });

  test("rejects a loopback address", () => {
    expect(resolvePublicBaseUrl("https://localhost:7830")).toEqual({
      ok: false,
      reason: "loopback",
    });
  });

  test("rejects a non-https URL", () => {
    expect(resolvePublicBaseUrl("http://foo.ts.net")).toEqual({
      ok: false,
      reason: "non-https",
    });
  });

  test("rejects an unparseable value", () => {
    expect(resolvePublicBaseUrl("nope")).toEqual({
      ok: false,
      reason: "unparseable",
    });
  });

  test("rejects a tunnel provider's website (e.g. a Tailscale admin invite link)", () => {
    // The exact papercut: a lost user pastes a Tailscale admin invite URL, which
    // is https and non-loopback and so would otherwise be accepted.
    expect(
      resolvePublicBaseUrl("https://login.tailscale.com/admin/invite/abc123"),
    ).toEqual({ ok: false, reason: "service-website" });
    expect(resolvePublicBaseUrl("https://ngrok.com")).toEqual({
      ok: false,
      reason: "service-website",
    });
    expect(resolvePublicBaseUrl("https://dash.cloudflare.com/login")).toEqual({
      ok: false,
      reason: "service-website",
    });
  });

  test("accepts a user's real Tailscale endpoint, not just the vendor site", () => {
    // A genuine *.ts.net endpoint is never a listed vendor host.
    expect(resolvePublicBaseUrl("https://my-box.tail1234.ts.net")).toEqual({
      ok: true,
      url: "https://my-box.tail1234.ts.net",
    });
  });
});

describe("publicBaseUrlRejectionMessage", () => {
  test("names the specific vendor for a service-website URL", () => {
    expect(
      publicBaseUrlRejectionMessage(
        "service-website",
        "https://login.tailscale.com/admin/invite/abc",
      ),
    ).toBe(
      "This is Tailscale's website, not your assistant's address. Run `vellum tunnel` on the host to get one.",
    );
    expect(
      publicBaseUrlRejectionMessage("service-website", "https://ngrok.com"),
    ).toContain("ngrok's website");
    expect(
      publicBaseUrlRejectionMessage(
        "service-website",
        "https://dash.cloudflare.com",
      ),
    ).toContain("Cloudflare's website");
  });

  test("falls back to a generic vendor label without a value", () => {
    expect(publicBaseUrlRejectionMessage("service-website")).toContain(
      "the tunnel provider's website",
    );
  });
});

describe("buildRemoteWebPairingUrl", () => {
  test("carries the device code in the fragment", () => {
    expect(
      buildRemoteWebPairingUrl({
        verificationUri: "https://foo.ts.net/assistant/pair",
        deviceCode: "DEV-123",
      }),
    ).toBe("https://foo.ts.net/assistant/pair#device_code=DEV-123");
  });
});
