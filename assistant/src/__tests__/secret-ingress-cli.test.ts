import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that depend on them
// ---------------------------------------------------------------------------

let mockConfig: Record<string, unknown> = {
  secretDetection: {
    enabled: true,
    blockIngress: true,
  },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getRootDir: () => "/tmp/vellum-test-secret-ingress-cli",
  getWorkspaceDir: () => "/tmp/vellum-test-secret-ingress-cli/workspace",
  getSignalsDir: () => "/tmp/vellum-test-secret-ingress-cli/signals",
}));

// ---------------------------------------------------------------------------
// Test: CLI signal path uses registerUserMessageCallback which calls
// checkIngressForSecrets before calling persistAndProcessMessage.
//
// We test the callback behavior directly rather than the full signal file
// flow, since the signal handler is just file I/O around the callback.
// ---------------------------------------------------------------------------

import { resetAllowlist } from "../security/secret-allowlist.js";
import { checkIngressForSecrets } from "../security/secret-ingress.js";

/**
 * Simulates the user-message callback registered in DaemonServer.start().
 * This mirrors the logic in assistant/src/daemon/server.ts lines 512-556.
 */
function makeUserMessageCallback() {
  const persistAndProcessMessageMock = mock(
    async (
      _conversationKey: string,
      _content: string,
      _sourceChannel: string,
      _sourceInterface: string,
    ) => undefined,
  );

  const callback = async (params: {
    conversationKey: string;
    content: string;
    sourceChannel: string;
    sourceInterface: string;
  }): Promise<{ accepted: boolean; error?: string; message?: string }> => {
    // This is the secret check that runs before any persistence
    const ingressResult = checkIngressForSecrets(params.content);
    if (ingressResult.blocked) {
      return {
        accepted: false,
        error: "secret_blocked" as const,
        message: ingressResult.userNotice,
      };
    }

    // If not blocked, would call persistAndProcessMessage
    await persistAndProcessMessageMock(
      params.conversationKey,
      params.content,
      params.sourceChannel,
      params.sourceInterface,
    );
    return { accepted: true };
  };

  return { callback, persistAndProcessMessageMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("secret ingress — CLI signal path", () => {
  beforeEach(() => {
    mockConfig = {
      secretDetection: {
        enabled: true,
        blockIngress: true,
      },
    };
    resetAllowlist();
  });

  test("CLI signal with secret content returns accepted: false with error: secret_blocked", async () => {
    const { callback, persistAndProcessMessageMock } =
      makeUserMessageCallback();

    const result = await callback({
      conversationKey: "test-key",
      content: "Here is my token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234",
      sourceChannel: "vellum",
      sourceInterface: "cli",
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toBe("secret_blocked");
    expect(result.message).toBeDefined();
    expect(persistAndProcessMessageMock).not.toHaveBeenCalled();
  });

  test("CLI signal with normal text returns accepted: true", async () => {
    const { callback, persistAndProcessMessageMock } =
      makeUserMessageCallback();

    const result = await callback({
      conversationKey: "test-key",
      content: "Hello, how are you?",
      sourceChannel: "vellum",
      sourceInterface: "cli",
    });

    expect(result.accepted).toBe(true);
    expect(result.error).toBeUndefined();
    expect(persistAndProcessMessageMock).toHaveBeenCalledTimes(1);
  });

  test("persistAndProcessMessage is NOT called when blocked", async () => {
    const { callback, persistAndProcessMessageMock } =
      makeUserMessageCallback();

    // AWS access key
    await callback({
      conversationKey: "test-key",
      content: "AWS key: AKIAIOSFODNN7EXAMPLE",
      sourceChannel: "vellum",
      sourceInterface: "cli",
    });

    expect(persistAndProcessMessageMock).not.toHaveBeenCalled();
  });

  test("CLI signal with Anthropic API key is blocked", async () => {
    const { callback } = makeUserMessageCallback();

    const key =
      "sk-ant-api03-abcDefGhiJklMnoPqrStuVwxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj";
    const result = await callback({
      conversationKey: "test-key",
      content: `Key: ${key}`,
      sourceChannel: "vellum",
      sourceInterface: "cli",
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toBe("secret_blocked");
  });

  test("CLI signal with JWT is not blocked (excluded pattern)", async () => {
    const { callback } = makeUserMessageCallback();

    const result = await callback({
      conversationKey: "test-key",
      content:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      sourceChannel: "vellum",
      sourceInterface: "cli",
    });

    expect(result.accepted).toBe(true);
  });

  test("CLI signal with blockIngress: false allows secrets through", async () => {
    mockConfig = {
      secretDetection: {
        enabled: true,
        blockIngress: false,
      },
    };

    const { callback, persistAndProcessMessageMock } =
      makeUserMessageCallback();

    const result = await callback({
      conversationKey: "test-key",
      content: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234",
      sourceChannel: "vellum",
      sourceInterface: "cli",
    });

    expect(result.accepted).toBe(true);
    expect(persistAndProcessMessageMock).toHaveBeenCalledTimes(1);
  });
});
