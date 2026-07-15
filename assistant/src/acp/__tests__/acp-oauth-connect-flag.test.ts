/**
 * Tests for `acp-oauth-connect-flag.ts` — the on/off predicate gating the
 * in-app Connect Claude Code OAuth flow for ACP. The assistant flag resolver is
 * mocked so the test asserts the composition: the predicate forwards
 * `ACP_CLAUDE_OAUTH_CONNECT` and the config to `isAssistantFeatureFlagEnabled`
 * and returns its boolean directly (default off).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../config/schema.js";

// The resolver is mocked BEFORE importing the module under test so the import
// observes the spy at load time. The specifier is resolved relative to THIS
// test file.
const isAssistantFeatureFlagEnabled = mock(
  (_flag: string, _config: AssistantConfig): boolean => false,
);

mock.module("../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled,
}));

const { isAcpClaudeOauthConnectEnabled, ACP_CLAUDE_OAUTH_CONNECT } =
  await import("../acp-oauth-connect-flag.js");

const cfg = {} as AssistantConfig;

describe("acp-oauth-connect-flag", () => {
  beforeEach(() => {
    isAssistantFeatureFlagEnabled.mockReset();
  });

  test("constant is the kebab-case flag id", () => {
    expect(ACP_CLAUDE_OAUTH_CONNECT).toBe("acp-claude-oauth-connect");
  });

  test("defaults false when the resolver returns false", () => {
    isAssistantFeatureFlagEnabled.mockReturnValue(false);

    expect(isAcpClaudeOauthConnectEnabled(cfg)).toBe(false);
    expect(isAssistantFeatureFlagEnabled).toHaveBeenCalledTimes(1);
    expect(isAssistantFeatureFlagEnabled).toHaveBeenCalledWith(
      ACP_CLAUDE_OAUTH_CONNECT,
      cfg,
    );
  });

  test("true when the flag is enabled, resolver called with the flag id + config", () => {
    isAssistantFeatureFlagEnabled.mockReturnValue(true);

    expect(isAcpClaudeOauthConnectEnabled(cfg)).toBe(true);
    expect(isAssistantFeatureFlagEnabled).toHaveBeenCalledWith(
      ACP_CLAUDE_OAUTH_CONNECT,
      cfg,
    );
  });
});
