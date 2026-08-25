import { describe, expect, test } from "bun:test";

import {
  buildRemoteWebPairingUrl,
  parsePairingAddress,
  parseRemoteWebPairingParams,
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
