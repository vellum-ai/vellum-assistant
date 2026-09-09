/**
 * Tests for the shared base64 payload decoder.
 *
 * Two callers with different shapes meet here: an attachment preview hands it a
 * full `data:` URI, the native camera bridge hands it the payload alone. The
 * cases below are the boundary between them, plus the two answers the callers
 * branch on, which are not the same answer: null is "nothing to decode, take
 * the other path", and a throw is "these bytes are broken".
 */

import { describe, expect, test } from "bun:test";

import { decodeBase64Payload } from "./base64";

describe("decodeBase64Payload", () => {
  test("decodes bare base64, which is what the native bridge answers with", () => {
    const bytes = decodeBase64Payload(btoa("hello"));
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("hello");
  });

  test("decodes the payload out of a data URI", () => {
    const bytes = decodeBase64Payload(
      `data:image/jpeg;base64,${btoa("hello")}`,
    );
    expect(new TextDecoder().decode(bytes!)).toBe("hello");
  });

  test("reads the two shapes as the same bytes", () => {
    const payload = btoa("payload bytes");
    expect(Array.from(decodeBase64Payload(payload)!)).toEqual(
      Array.from(decodeBase64Payload(`data:image/jpeg;base64,${payload}`)!),
    );
  });

  test("carries arbitrary bytes through, not just text", () => {
    const raw = new Uint8Array([0, 255, 16, 128, 7]);
    const payload = btoa(String.fromCharCode(...raw));
    expect(Array.from(decodeBase64Payload(payload)!)).toEqual(Array.from(raw));
  });

  test("answers null for an empty string", () => {
    expect(decodeBase64Payload("")).toBeNull();
  });

  test("answers null for a data URI with nothing after the marker", () => {
    expect(decodeBase64Payload("data:image/jpeg;base64,")).toBeNull();
  });

  test("answers null for a data URI that is not base64 encoded", () => {
    // The preview callers hand this straight to a loader that can take a URL,
    // so "no bytes here" has to be distinguishable from bytes.
    expect(decodeBase64Payload("data:text/plain,hello")).toBeNull();
  });

  test("throws on base64 that is present but malformed", () => {
    // Not null: a caller with a fallback for "no bytes" would take it for a
    // frame that is really there and really broken, and go on as if the answer
    // were a URL it could fetch.
    expect(() => decodeBase64Payload("!!!not base64!!!")).toThrow();
    expect(() =>
      decodeBase64Payload("data:image/jpeg;base64,!!!not base64!!!"),
    ).toThrow();
  });
});
