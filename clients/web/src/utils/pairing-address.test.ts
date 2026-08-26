import { describe, expect, test } from "bun:test";

import {
  isPublicBaseUrlRejection,
  pairingLinkForBase,
  publicBaseUrlRejectionMessage,
} from "@/utils/pairing-address";

describe("pairingLinkForBase", () => {
  test("puts the pair route on the base and the code in the fragment", () => {
    expect(pairingLinkForBase("https://foo.ts.net", "DEV-123")).toBe(
      "https://foo.ts.net/assistant/pair#device_code=DEV-123",
    );
  });

  test("keeps a deployment path prefix ahead of the pair route", () => {
    expect(
      pairingLinkForBase("https://host.example/assistant-1", "DEV-123"),
    ).toBe(
      "https://host.example/assistant-1/assistant/pair#device_code=DEV-123",
    );
  });

  test("canonicalizes a base that already carries a slash or an app route", () => {
    expect(pairingLinkForBase("https://foo.ts.net/", "DEV-123")).toBe(
      "https://foo.ts.net/assistant/pair#device_code=DEV-123",
    );
    expect(pairingLinkForBase("https://foo.ts.net/assistant/pair", "D")).toBe(
      "https://foo.ts.net/assistant/pair#device_code=D",
    );
  });

  test("reports an unparseable base rather than composing nonsense", () => {
    expect(pairingLinkForBase("not a url", "DEV-123")).toBeNull();
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
      "This is Tailscale's website, not your assistant's address. Start a tunnel on the host to get one; `vellum tunnel --help` lists the providers.",
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

describe("isPublicBaseUrlRejection", () => {
  test("accepts every reason the mapper has copy for", () => {
    for (const reason of [
      "unparseable",
      "loopback",
      "private-address",
      "non-https",
      "service-website",
    ]) {
      expect(isPublicBaseUrlRejection(reason)).toBe(true);
    }
  });

  test("refuses anything else, including inherited object keys", () => {
    expect(isPublicBaseUrlRejection("reason-from-a-newer-host")).toBe(false);
    expect(isPublicBaseUrlRejection("toString")).toBe(false);
    expect(isPublicBaseUrlRejection(undefined)).toBe(false);
  });
});
