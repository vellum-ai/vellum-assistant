/**
 * Unit tests for the Anthropic token classifier and ACP OAuth-field guard.
 */

import { describe, expect, test } from "bun:test";

import {
  ACP_OAUTH_TOKEN_FIELD,
  ACP_SERVICE,
  AcpCredentialFormatError,
  assertAcpCredentialFormat,
  classifyAnthropicToken,
} from "../acp-credentials.js";

describe("classifyAnthropicToken", () => {
  test("classifies an OAuth token", () => {
    expect(classifyAnthropicToken("sk-ant-oat01-x")).toBe("oauth");
  });

  test("classifies an API key", () => {
    expect(classifyAnthropicToken("sk-ant-api03-x")).toBe("api_key");
  });

  test("classifies an arbitrary string as unknown", () => {
    expect(classifyAnthropicToken("hello world")).toBe("unknown");
    expect(classifyAnthropicToken("")).toBe("unknown");
    expect(classifyAnthropicToken("sk-ant-something")).toBe("unknown");
  });

  test("tolerates surrounding whitespace", () => {
    expect(classifyAnthropicToken("  sk-ant-oat01-x  ")).toBe("oauth");
    expect(classifyAnthropicToken("\tsk-ant-api03-x\n")).toBe("api_key");
  });
});

describe("assertAcpCredentialFormat", () => {
  test("throws when an API key is written into the OAuth field", () => {
    expect(() =>
      assertAcpCredentialFormat(ACP_OAUTH_TOKEN_FIELD, "sk-ant-api03-x"),
    ).toThrow(AcpCredentialFormatError);
  });

  test("throws even when the API key has surrounding whitespace", () => {
    expect(() =>
      assertAcpCredentialFormat(ACP_OAUTH_TOKEN_FIELD, "  sk-ant-api03-x  "),
    ).toThrow(AcpCredentialFormatError);
  });

  test("does not throw for an OAuth token in the OAuth field", () => {
    expect(() =>
      assertAcpCredentialFormat(ACP_OAUTH_TOKEN_FIELD, "sk-ant-oat01-x"),
    ).not.toThrow();
  });

  test("does not throw for an unknown value in the OAuth field", () => {
    expect(() =>
      assertAcpCredentialFormat(ACP_OAUTH_TOKEN_FIELD, "whatever"),
    ).not.toThrow();
  });

  test("does not throw for an API key in a non-OAuth field", () => {
    expect(() =>
      assertAcpCredentialFormat("some_other_field", "sk-ant-api03-x"),
    ).not.toThrow();
  });
});

describe("constants", () => {
  test("expose the ACP service and OAuth field names", () => {
    expect(ACP_SERVICE).toBe("acp");
    expect(ACP_OAUTH_TOKEN_FIELD).toBe("claude_oauth_token");
  });
});
