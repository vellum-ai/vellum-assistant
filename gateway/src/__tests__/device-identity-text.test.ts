import { describe, expect, test } from "bun:test";

import {
  capDeviceIdentityText,
  MAX_CLIENT_REPORTED_NAME_CHARS,
  MAX_PAIRING_USER_AGENT_CHARS,
} from "../auth/device-identity-text.js";

describe("capDeviceIdentityText", () => {
  test("null passes through as null", () => {
    expect(capDeviceIdentityText(null, MAX_CLIENT_REPORTED_NAME_CHARS)).toBe(
      null,
    );
  });

  test("undefined passes through as null", () => {
    expect(
      capDeviceIdentityText(undefined, MAX_CLIENT_REPORTED_NAME_CHARS),
    ).toBe(null);
  });

  test("whitespace-only value becomes null", () => {
    expect(
      capDeviceIdentityText("   ", MAX_CLIENT_REPORTED_NAME_CHARS),
    ).toBe(null);
  });

  test("trims surrounding whitespace", () => {
    expect(
      capDeviceIdentityText("  Noa's iPhone  ", MAX_CLIENT_REPORTED_NAME_CHARS),
    ).toBe("Noa's iPhone");
  });

  test("strips control characters including an embedded newline", () => {
    const withNewline = "Noa's" + String.fromCharCode(10) + "iPhone";
    expect(
      capDeviceIdentityText(withNewline, MAX_CLIENT_REPORTED_NAME_CHARS),
    ).toBe("Noa'siPhone");
  });

  test("strips an ESC control character", () => {
    const withEsc = "evil" + String.fromCharCode(27) + "[31mname";
    expect(capDeviceIdentityText(withEsc, MAX_CLIENT_REPORTED_NAME_CHARS)).toBe(
      "evil[31mname",
    );
  });

  test("value at exactly maxChars is unchanged", () => {
    const value = "a".repeat(MAX_CLIENT_REPORTED_NAME_CHARS);
    const result = capDeviceIdentityText(value, MAX_CLIENT_REPORTED_NAME_CHARS);
    expect(result).toBe(value);
    expect(result?.length).toBe(MAX_CLIENT_REPORTED_NAME_CHARS);
  });

  test("over-length User-Agent is truncated to exactly the max", () => {
    const value = "u".repeat(600);
    const result = capDeviceIdentityText(value, MAX_PAIRING_USER_AGENT_CHARS);
    expect(result?.length).toBe(MAX_PAIRING_USER_AGENT_CHARS);
    expect(result).toBe("u".repeat(MAX_PAIRING_USER_AGENT_CHARS));
  });

  test("a normal short value is returned unchanged", () => {
    expect(
      capDeviceIdentityText("Chrome on macOS", MAX_CLIENT_REPORTED_NAME_CHARS),
    ).toBe("Chrome on macOS");
  });
});
