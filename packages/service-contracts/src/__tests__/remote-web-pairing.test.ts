import { describe, expect, test } from "bun:test";

import {
  buildRemoteWebPairingUrl,
  isDnsIndependentLoopbackUrl,
  isLoopbackPublicUrl,
  isPrivateNetworkPublicUrl,
  isRetryablePairingReason,
  pairingSessionSurvives,
  parsePairingAddress,
  parseRemoteWebPairingParams,
  resolvePublicBaseUrl,
  RETRYABLE_PAIRING_REASONS,
  type PairingFailureReason,
  type PublicBaseUrlRejection,
} from "../remote-web-pairing.js";

describe("parseRemoteWebPairingParams", () => {
  test("reads snake_case fragment parameters", () => {
    expect(
      parseRemoteWebPairingParams(
        "https://assistant.example.com/assistant/pair#device_code=device-1&user_code=ABCD-EFGH",
      ),
    ).toEqual({ deviceCode: "device-1", userCode: "ABCD-EFGH" });
  });

  test("reads camelCase query parameters", () => {
    expect(
      parseRemoteWebPairingParams(
        "https://assistant.example.com/assistant/pair?deviceCode=device-2&userCode=WXYZ-1234",
      ),
    ).toEqual({ deviceCode: "device-2", userCode: "WXYZ-1234" });
  });

  test("accepts a relative link", () => {
    expect(
      parseRemoteWebPairingParams("/assistant/pair#device_code=device-3"),
    ).toEqual({ deviceCode: "device-3", userCode: null });
  });

  test("reports null when no codes are present", () => {
    expect(
      parseRemoteWebPairingParams("https://assistant.example.com/assistant"),
    ).toEqual({ deviceCode: null, userCode: null });
  });
});

describe("parsePairingAddress", () => {
  test("splits a pairing link into its base and device code", () => {
    const link = buildRemoteWebPairingUrl({
      verificationUri: "https://assistant.example.com/assistant/pair",
      deviceCode: "device-1",
    });

    expect(parsePairingAddress(link)).toEqual({
      ok: true,
      publicBaseUrl: "https://assistant.example.com",
      deviceCode: "device-1",
    });
  });

  test("accepts the device code in the query string", () => {
    expect(
      parsePairingAddress(
        "https://assistant.example.com/assistant/pair?deviceCode=device-2",
      ),
    ).toEqual({
      ok: true,
      publicBaseUrl: "https://assistant.example.com",
      deviceCode: "device-2",
    });
  });

  test("preserves a path prefix while dropping the app-route suffix", () => {
    expect(
      parsePairingAddress(
        "https://host.example.com/assistant-123/assistant/pair#device_code=device-3",
      ),
    ).toEqual({
      ok: true,
      publicBaseUrl: "https://host.example.com/assistant-123",
      deviceCode: "device-3",
    });
  });

  test("drops a trailing app-route suffix from a bare address", () => {
    expect(
      parsePairingAddress("https://assistant.example.com/assistant/pair"),
    ).toEqual({
      ok: true,
      publicBaseUrl: "https://assistant.example.com",
      deviceCode: null,
    });
  });

  test("accepts a bare address with no device code", () => {
    expect(parsePairingAddress("https://assistant.example.com")).toEqual({
      ok: true,
      publicBaseUrl: "https://assistant.example.com",
      deviceCode: null,
    });
  });

  test.each<[string, PublicBaseUrlRejection]>([
    ["not a url", "unparseable"],
    ["https://localhost:3000", "loopback"],
    ["https://127.0.0.1:3000", "loopback"],
    ["http://assistant.example.com", "non-https"],
    ["https://login.tailscale.com/admin/invite/abc123", "service-website"],
  ])("rejects %s", (raw, reason) => {
    expect(parsePairingAddress(raw)).toEqual({ ok: false, reason });
  });
});

describe("resolvePublicBaseUrl private-address containment", () => {
  // A host POSTs to whatever address was pasted, so an IP literal aimed at the
  // local network (or at 169.254.169.254, the cloud instance metadata
  // endpoint) is a blind SSRF target and is refused before any request.
  test.each([
    ["https://0.0.0.0", "0/8"],
    ["https://10.0.0.1", "10/8"],
    ["https://10.255.255.254:8443", "10/8 with a port"],
    ["https://169.254.169.254", "169.254/16 cloud metadata"],
    ["https://172.16.0.1", "172.16/12 low edge"],
    ["https://172.31.255.254", "172.16/12 high edge"],
    ["https://192.0.0.8", "192.0.0/24"],
    ["https://192.168.1.5", "192.168/16"],
    ["https://198.18.0.1", "198.18/15"],
    ["https://198.19.255.254", "198.18/15 high half"],
    ["https://224.0.0.1", "224/4 multicast"],
    ["https://240.0.0.1", "240/4 reserved"],
    ["https://255.255.255.255", "broadcast"],
    // WHATWG URL canonicalizes these to a dotted-quad before the check.
    ["https://2130706433", "decimal-encoded 127.0.0.1"],
    ["https://0xa000001", "hex-encoded 10.0.0.1"],
    ["https://[::]", "IPv6 unspecified"],
    ["https://[fd00::1]", "fc00::/7 unique-local"],
    ["https://[fc00::5]", "fc00::/7 low edge"],
    ["https://[fe80::1]", "fe80::/10 link-local"],
    ["https://[ff02::1]", "ff00::/8 multicast"],
    ["https://[::ffff:10.0.0.1]", "IPv4-mapped private"],
    ["https://[::ffff:169.254.169.254]", "IPv4-mapped metadata"],
    ["https://[::192.168.1.5]", "IPv4-compatible private"],
  ])("refuses %s (%s)", (raw) => {
    const result = resolvePublicBaseUrl(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    // 127/8 and ::1 keep their more specific loopback reason.
    expect(["private-address", "loopback"]).toContain(result.reason);
  });

  test.each([
    "https://10.0.0.1",
    "https://169.254.169.254",
    "https://172.20.3.4",
    "https://192.168.1.5",
    "https://198.18.0.1",
    "https://[fd00::1]",
    "https://[fe80::1]",
    "https://[::ffff:10.0.0.1]",
  ])("reports %s as private-address, not loopback", (raw) => {
    expect(resolvePublicBaseUrl(raw)).toEqual({
      ok: false,
      reason: "private-address",
    });
  });

  // A wildcard bind reaches a listener on the machine that dials it, so it
  // gets the more specific loopback reason and the "points back at this
  // machine" guidance that goes with it.
  test.each([
    ["https://0.0.0.0", "IPv4 wildcard"],
    ["https://[::]", "IPv6 wildcard"],
    ["https://[::ffff:0.0.0.0]", "IPv4-mapped wildcard"],
    ["https://[::ffff:127.0.0.1]", "IPv4-mapped loopback"],
  ])("reports %s (%s) as loopback", (raw) => {
    expect(isLoopbackPublicUrl(raw)).toBe(true);
    expect(resolvePublicBaseUrl(raw)).toEqual({
      ok: false,
      reason: "loopback",
    });
  });

  // Tailscale hands out 100.64.0.0/10 CGNAT addresses and `*.ts.net` names are
  // a supported pairing target, so neither the range nor any hostname is
  // filtered. Names are never resolved (see isPrivateNetworkPublicUrl).
  test.each([
    "https://my-box.tail1234.ts.net",
    "https://assistant.example.com",
    "https://100.101.102.103",
    "https://[2606:4700::1111]",
    "https://172.32.0.1",
    "https://192.0.1.1",
    "https://198.20.0.1",
    "https://223.255.255.255",
  ])("still resolves %s", (raw) => {
    expect(resolvePublicBaseUrl(raw)).toEqual({ ok: true, url: raw });
  });

  test("isPrivateNetworkPublicUrl reports a plain hostname as public", () => {
    expect(isPrivateNetworkPublicUrl("https://my-box.tail1234.ts.net")).toBe(
      false,
    );
    expect(isPrivateNetworkPublicUrl("not a url")).toBe(false);
    expect(isPrivateNetworkPublicUrl("https://192.168.0.1")).toBe(true);
  });
});

describe("resolvePublicBaseUrl localhost normalization", () => {
  // A terminal DNS root dot survives WHATWG parsing, and resolvers read the
  // absolute name as loopback, so the dot is stripped before every host
  // comparison. The whole `.localhost` namespace is reserved (RFC 6761) and
  // resolves to loopback too.
  test.each([
    ["https://localhost.", "absolute localhost name"],
    ["https://localhost.:3000", "absolute localhost name with a port"],
    ["https://LOCALHOST.", "uppercase absolute localhost name"],
    ["https://foo.localhost", "reserved .localhost namespace"],
    ["https://foo.localhost.", "absolute .localhost namespace"],
    ["https://a.b.localhost.", "nested .localhost namespace"],
    ["https://127.0.0.1.", "absolute IPv4 loopback literal"],
  ])("reports %s (%s) as loopback", (raw) => {
    expect(isLoopbackPublicUrl(raw)).toBe(true);
    expect(resolvePublicBaseUrl(raw)).toEqual({
      ok: false,
      reason: "loopback",
    });
  });

  test("reports an absolute private literal as private-address", () => {
    expect(isPrivateNetworkPublicUrl("https://10.0.0.1.")).toBe(true);
    expect(resolvePublicBaseUrl("https://10.0.0.1.")).toEqual({
      ok: false,
      reason: "private-address",
    });
  });

  test("reports an absolute vendor-site name as service-website", () => {
    expect(resolvePublicBaseUrl("https://login.tailscale.com.")).toEqual({
      ok: false,
      reason: "service-website",
    });
  });

  test.each([
    "https://my-box.tail1234.ts.net.",
    "https://assistant.example.com.",
    "https://localhostage.example.com",
    "https://mylocalhost.example.com.",
  ])("still resolves %s", (raw) => {
    expect(isLoopbackPublicUrl(raw)).toBe(false);
    expect(resolvePublicBaseUrl(raw)).toEqual({ ok: true, url: raw });
  });
});

describe("isDnsIndependentLoopbackUrl", () => {
  test.each([
    ["http://localhost:7830", "the exact name"],
    ["http://LOCALHOST.:7830", "the absolute, uppercase name"],
    ["http://127.0.0.1:7830", "an IPv4 loopback literal"],
    ["http://127.9.9.9", "the rest of 127/8"],
    ["http://[::1]:7830", "the IPv6 loopback literal"],
    ["http://[::ffff:127.0.0.1]", "an IPv4-mapped loopback literal"],
    ["http://0.0.0.0:7830", "the IPv4 wildcard bind"],
    ["http://[::]:7830", "the IPv6 wildcard bind"],
  ])("%s reaches this machine (%s)", (raw) => {
    expect(isDnsIndependentLoopbackUrl(raw)).toBe(true);
    expect(isLoopbackPublicUrl(raw)).toBe(true);
  });

  // RFC 6761 reserves the namespace and says resolvers should map it to
  // loopback, but glibc does not by default, so the name is ordinary DNS and
  // can answer with any address. The wide predicate still refuses it as
  // loopback; the narrow one refuses to hand it a loopback privilege.
  test.each([
    ["https://foo.localhost", "reserved .localhost namespace"],
    ["https://foo.localhost.", "absolute .localhost namespace"],
    ["https://a.b.localhost", "nested .localhost namespace"],
  ])("%s is loopback but not DNS-independent (%s)", (raw) => {
    expect(isLoopbackPublicUrl(raw)).toBe(true);
    expect(isDnsIndependentLoopbackUrl(raw)).toBe(false);
  });

  test.each([
    "https://assistant.example.com",
    "https://localhostage.example.com",
    "https://10.0.0.5",
    "not a url",
  ])("%s is not loopback at all", (raw) => {
    expect(isDnsIndependentLoopbackUrl(raw)).toBe(false);
    expect(isLoopbackPublicUrl(raw)).toBe(false);
  });
});

/** Every reason, so a classification table cannot silently miss one. */
const EVERY_PAIRING_REASON: PairingFailureReason[] = [
  "invalid-address",
  "unknown-session",
  "expired",
  "unreachable",
  "gateway-retryable",
  "gateway",
  "import",
  "import-precheck",
];

describe("isRetryablePairingReason", () => {
  test.each([
    // Nothing reached the assistant, so the session and code are untouched.
    "unreachable",
    // The assistant refused with a status that released the code.
    "gateway-retryable",
  ] as const)("%s is worth another attempt", (reason) => {
    expect(isRetryablePairingReason(reason)).toBe(true);
  });

  test.each([
    "invalid-address",
    "unknown-session",
    "expired",
    // The assistant answered with something unusable, past which the code is
    // spent rather than released.
    "gateway",
    "import",
    // Nothing was spent, but an identical attempt is refused identically:
    // only a caller that changes the name it asked for gets past this.
    "import-precheck",
  ] as const)("%s settles the attempt", (reason) => {
    expect(isRetryablePairingReason(reason)).toBe(false);
  });

  test("an absent reason settles the attempt", () => {
    expect(isRetryablePairingReason(undefined)).toBe(false);
    expect(isRetryablePairingReason(null)).toBe(false);
  });

  test("the exported set is exactly the reasons worth another attempt", () => {
    expect(
      EVERY_PAIRING_REASON.filter(isRetryablePairingReason).sort(),
    ).toEqual(["gateway-retryable", "unreachable"]);
    expect([...RETRYABLE_PAIRING_REASONS].sort()).toEqual([
      "gateway-retryable",
      "unreachable",
    ]);
  });
});

describe("pairingSessionSurvives", () => {
  test.each([
    // Nothing reached the assistant, so the session and code are untouched.
    "unreachable",
    // The assistant released the code before answering.
    "gateway-retryable",
    // The refusal happened before the exchange, so the code is unspent.
    "import-precheck",
  ] as const)("%s leaves the session pollable", (reason) => {
    expect(pairingSessionSurvives(reason)).toBe(true);
  });

  test.each([
    "invalid-address",
    "unknown-session",
    "expired",
    "gateway",
    // The exchange spent the code; only the local write failed.
    "import",
  ] as const)("%s leaves nothing to poll", (reason) => {
    expect(pairingSessionSurvives(reason)).toBe(false);
  });

  test("an absent reason leaves nothing to poll", () => {
    expect(pairingSessionSurvives(undefined)).toBe(false);
    expect(pairingSessionSurvives(null)).toBe(false);
  });

  test("a pre-check refusal is the one reason the two axes disagree on", () => {
    // A caller that reads retryability as "keep the session" throws away a
    // device code that is still good, which is what this reason exists to
    // prevent: nothing was spent, so the same handle completes the pairing
    // once the caller supplies a name that is free.
    const disagreeing = EVERY_PAIRING_REASON.filter(
      (reason) =>
        pairingSessionSurvives(reason) !== isRetryablePairingReason(reason),
    );
    expect(disagreeing).toEqual(["import-precheck"]);
  });
});
