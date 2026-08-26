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
      capDeviceIdentityText(
        "  Alice's iPhone  ",
        MAX_CLIENT_REPORTED_NAME_CHARS,
      ),
    ).toBe("Alice's iPhone");
  });

  test("strips control characters including an embedded newline", () => {
    const withNewline = "Alice's" + String.fromCharCode(10) + "iPhone";
    expect(
      capDeviceIdentityText(withNewline, MAX_CLIENT_REPORTED_NAME_CHARS),
    ).toBe("Alice'siPhone");
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

  test("control-character-only value becomes null, not an empty string", () => {
    const result = capDeviceIdentityText(
      String.fromCharCode(1),
      MAX_CLIENT_REPORTED_NAME_CHARS,
    );
    expect(result).toBe(null);
  });

  test("whitespace surrounding control characters still becomes null", () => {
    const value = "  " + String.fromCharCode(1) + "  ";
    expect(capDeviceIdentityText(value, MAX_CLIENT_REPORTED_NAME_CHARS)).toBe(
      null,
    );
  });

  test("stripping control characters exposes whitespace that also gets trimmed", () => {
    const value =
      " " + String.fromCharCode(1) + " hello " + String.fromCharCode(1) + " ";
    expect(capDeviceIdentityText(value, MAX_CLIENT_REPORTED_NAME_CHARS)).toBe(
      "hello",
    );
  });

  test("truncation at the char cap keeps a boundary surrogate pair whole rather than splitting it", () => {
    const maxChars = MAX_CLIENT_REPORTED_NAME_CHARS;
    const emoji = "\u{1F600}"; // surrogate pair: 2 UTF-16 code units, 1 code point
    // maxChars - 1 plain ASCII chars, then the emoji, then more filler,
    // so the emoji's surrogate pair straddles the UTF-16 code-unit offset
    // `maxChars` (the boundary a naive .slice(0, maxChars) would cut at).
    const value = "a".repeat(maxChars - 1) + emoji + "bbbb";
    const result = capDeviceIdentityText(value, maxChars);
    expect(result).not.toBe(null);
    const safeResult = result ?? "";

    // The result must be either the emoji included whole, or excluded
    // entirely: never a lone unpaired surrogate.
    const withEmoji = "a".repeat(maxChars - 1) + emoji;
    const withoutEmoji = "a".repeat(maxChars);
    expect(safeResult === withEmoji || safeResult === withoutEmoji).toBe(
      true,
    );

    // Directly rule out an unpaired high or low surrogate anywhere in the
    // result, regardless of which branch above it landed on.
    const hasLoneHighSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(
      safeResult,
    );
    const hasLoneLowSurrogate = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      safeResult,
    );
    expect(hasLoneHighSurrogate).toBe(false);
    expect(hasLoneLowSurrogate).toBe(false);
  });
});
