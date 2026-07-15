/**
 * Tests for the shared ACP credential classifier and format guard.
 *
 * Pins the prefix-based classification of Anthropic credentials and the
 * field-vs-format assertion that routes a misplaced key/token to the correct
 * field. Pure functions — no mocks required.
 */

import { describe, expect, test } from "bun:test";

import {
  ACP_ANTHROPIC_API_KEY_FIELD,
  ACP_OAUTH_TOKEN_FIELD,
  ACP_SERVICE,
  AcpCredentialFormatError,
  assertAcpCredentialFormat,
  classifyAnthropicToken,
} from "../acp-credentials.js";

describe("classifyAnthropicToken", () => {
  test("classifies an API key by its sk-ant-api prefix", () => {
    expect(classifyAnthropicToken("sk-ant-api03-abc123")).toBe("api_key");
  });

  test("classifies an OAuth token by its sk-ant-oat prefix", () => {
    expect(classifyAnthropicToken("sk-ant-oat01-abc123")).toBe("oauth");
  });

  test("returns unknown for an unrecognized prefix", () => {
    expect(classifyAnthropicToken("sk-something-else")).toBe("unknown");
    expect(classifyAnthropicToken("")).toBe("unknown");
  });

  test("trims surrounding whitespace before classifying", () => {
    expect(classifyAnthropicToken("  sk-ant-api03-abc  ")).toBe("api_key");
    expect(classifyAnthropicToken("\n\tsk-ant-oat01-abc\n")).toBe("oauth");
  });
});

describe("assertAcpCredentialFormat", () => {
  test("throws when an API key is stored under the OAuth field", () => {
    expect(() =>
      assertAcpCredentialFormat(
        ACP_SERVICE,
        ACP_OAUTH_TOKEN_FIELD,
        "sk-ant-api03-abc",
      ),
    ).toThrow(AcpCredentialFormatError);
  });

  test("throws when an OAuth token is stored under the API-key field", () => {
    expect(() =>
      assertAcpCredentialFormat(
        ACP_SERVICE,
        ACP_ANTHROPIC_API_KEY_FIELD,
        "sk-ant-oat01-abc",
      ),
    ).toThrow(AcpCredentialFormatError);
  });

  test("passes for correctly paired credentials", () => {
    expect(() =>
      assertAcpCredentialFormat(
        ACP_SERVICE,
        ACP_OAUTH_TOKEN_FIELD,
        "sk-ant-oat01-abc",
      ),
    ).not.toThrow();
    expect(() =>
      assertAcpCredentialFormat(
        ACP_SERVICE,
        ACP_ANTHROPIC_API_KEY_FIELD,
        "sk-ant-api03-abc",
      ),
    ).not.toThrow();
  });

  test("passes for an unknown-prefix value in either field", () => {
    expect(() =>
      assertAcpCredentialFormat(
        ACP_SERVICE,
        ACP_OAUTH_TOKEN_FIELD,
        "mystery-token",
      ),
    ).not.toThrow();
    expect(() =>
      assertAcpCredentialFormat(
        ACP_SERVICE,
        ACP_ANTHROPIC_API_KEY_FIELD,
        "mystery-token",
      ),
    ).not.toThrow();
  });

  test("no-ops for a non-acp service even on a format mismatch", () => {
    expect(() =>
      assertAcpCredentialFormat(
        "other",
        ACP_OAUTH_TOKEN_FIELD,
        "sk-ant-api03-abc",
      ),
    ).not.toThrow();
  });
});
