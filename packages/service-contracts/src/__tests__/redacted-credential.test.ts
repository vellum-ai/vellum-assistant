import { describe, expect, test } from "bun:test";

import {
  buildRedactedSentinel,
  createRedactedSentinelRegex,
  isRevealableSentinel,
  neutralizeRedactedSentinels,
  parseRedactedSentinel,
  REDACTED_SENTINEL_CLOSE,
  REDACTED_SENTINEL_OPEN,
} from "../redacted-credential";

describe("buildRedactedSentinel", () => {
  test("plain shape carries only the type", () => {
    expect(buildRedactedSentinel({ type: "OpenAI Project Key" })).toBe(
      `${REDACTED_SENTINEL_OPEN}redacted:OpenAI Project Key${REDACTED_SENTINEL_CLOSE}`,
    );
  });

  test("enriched shape carries service and field", () => {
    expect(
      buildRedactedSentinel({
        type: "Anthropic API Key",
        service: "anthropic",
        field: "api_key",
      }),
    ).toBe(
      `${REDACTED_SENTINEL_OPEN}redacted:Anthropic API Key:anthropic:api_key${REDACTED_SENTINEL_CLOSE}`,
    );
  });

  test("colon-qualified segments are percent-encoded, not rejected", () => {
    // Real vaults contain colon-qualified service names (migration
    // 018-rekey-compound-credential-keys produces `integration:google`).
    // The builder must keep those revealable by encoding the delimiter.
    expect(
      buildRedactedSentinel({
        type: "Generic Secret",
        service: "integration:google",
        field: "access_token",
      }),
    ).toBe(
      `${REDACTED_SENTINEL_OPEN}redacted:Generic Secret:integration%3Agoogle:access_token${REDACTED_SENTINEL_CLOSE}`,
    );
  });

  test("plain identifier segments stay literal (unencoded)", () => {
    expect(
      buildRedactedSentinel({
        type: "Anthropic API Key",
        service: "anthropic",
        field: "api-key.v2_test",
      }),
    ).toBe(
      `${REDACTED_SENTINEL_OPEN}redacted:Anthropic API Key:anthropic:api-key.v2_test${REDACTED_SENTINEL_CLOSE}`,
    );
  });

  test("empty service or field degrades to the plain shape", () => {
    expect(
      buildRedactedSentinel({
        type: "Generic Secret",
        service: "",
        field: "x",
      }),
    ).toBe(
      `${REDACTED_SENTINEL_OPEN}redacted:Generic Secret${REDACTED_SENTINEL_CLOSE}`,
    );
    expect(
      buildRedactedSentinel({
        type: "Generic Secret",
        service: "x",
        field: "",
      }),
    ).toBe(
      `${REDACTED_SENTINEL_OPEN}redacted:Generic Secret${REDACTED_SENTINEL_CLOSE}`,
    );
  });

  test("missing field alone degrades to the plain shape", () => {
    expect(
      buildRedactedSentinel({ type: "Generic Secret", service: "anthropic" }),
    ).toBe(
      `${REDACTED_SENTINEL_OPEN}redacted:Generic Secret${REDACTED_SENTINEL_CLOSE}`,
    );
  });

  test("throws on a type label that would corrupt the format", () => {
    expect(() => buildRedactedSentinel({ type: "bad:type" })).toThrow();
    expect(() =>
      buildRedactedSentinel({ type: `bad${REDACTED_SENTINEL_CLOSE}type` }),
    ).toThrow();
  });
});

describe("parseRedactedSentinel", () => {
  test("round-trips the plain shape", () => {
    const s = buildRedactedSentinel({ type: "GitHub Token" });
    expect(parseRedactedSentinel(s)).toEqual({ type: "GitHub Token" });
  });

  test("round-trips the enriched shape", () => {
    const s = buildRedactedSentinel({
      type: "GitHub Token",
      service: "github-app",
      field: "pem",
    });
    const parsed = parseRedactedSentinel(s);
    expect(parsed).toEqual({
      type: "GitHub Token",
      service: "github-app",
      field: "pem",
    });
    expect(parsed && isRevealableSentinel(parsed)).toBe(true);
  });

  test("round-trips encoded segments back to the original identifiers", () => {
    const original = {
      type: "OAuth Access Token",
      service: "integration:google",
      field: "access token/v2 (staging)",
    };
    const parsed = parseRedactedSentinel(buildRedactedSentinel(original));
    expect(parsed).toEqual(original);
    expect(parsed && isRevealableSentinel(parsed)).toBe(true);
  });

  test("malformed percent-escape degrades to the plain shape", () => {
    // Daemon-encoded segments always decode; a hand-forged sentinel with a
    // broken escape must not surface bogus vault coordinates.
    const forged = `${REDACTED_SENTINEL_OPEN}redacted:Generic Secret:bad%zzsvc:field${REDACTED_SENTINEL_CLOSE}`;
    const parsed = parseRedactedSentinel(forged);
    expect(parsed).toEqual({ type: "Generic Secret" });
    expect(parsed && isRevealableSentinel(parsed)).toBe(false);
  });

  test("rejects non-sentinel and partial inputs", () => {
    expect(parseRedactedSentinel("nope")).toBeUndefined();
    expect(
      parseRedactedSentinel(`${REDACTED_SENTINEL_OPEN}redacted:Type`),
    ).toBeUndefined();
    expect(
      parseRedactedSentinel(
        `prefix ${buildRedactedSentinel({ type: "T" })} suffix`,
      ),
    ).toBeUndefined();
  });

  test("plain shape is not revealable", () => {
    const parsed = parseRedactedSentinel(
      buildRedactedSentinel({ type: "AWS Access Key" }),
    );
    expect(parsed && isRevealableSentinel(parsed)).toBe(false);
  });
});

describe("neutralizeRedactedSentinels", () => {
  test("a forged sentinel no longer matches the consumer regex", () => {
    const forged = buildRedactedSentinel({
      type: "GitHub Token",
      service: "github-app",
      field: "pem",
    });
    const neutralized = neutralizeRedactedSentinels(`quote: ${forged}`);
    expect([...neutralized.matchAll(createRedactedSentinelRegex())]).toEqual(
      [],
    );
    // Visually identical: only a zero-width word joiner was inserted.
    expect(neutralized.replaceAll("\u2060", "")).toBe(`quote: ${forged}`);
  });

  test("is idempotent", () => {
    const once = neutralizeRedactedSentinels(
      buildRedactedSentinel({ type: "A" }),
    );
    expect(neutralizeRedactedSentinels(once)).toBe(once);
  });

  test("leaves ordinary text untouched", () => {
    expect(neutralizeRedactedSentinels("plain text")).toBe("plain text");
    expect(
      neutralizeRedactedSentinels(`${REDACTED_SENTINEL_OPEN}not a sentinel`),
    ).toBe(`${REDACTED_SENTINEL_OPEN}not a sentinel`);
  });
});

describe("createRedactedSentinelRegex", () => {
  test("finds multiple sentinels of both shapes in one text", () => {
    const text = `a ${buildRedactedSentinel({ type: "A Key" })} b ${buildRedactedSentinel(
      { type: "B Key", service: "svc", field: "f" },
    )} c`;
    const matches = [...text.matchAll(createRedactedSentinelRegex())];
    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe("A Key");
    expect(matches[0][2]).toBeUndefined();
    expect(matches[1][1]).toBe("B Key");
    expect(matches[1][2]).toBe("svc");
    expect(matches[1][3]).toBe("f");
  });
});
