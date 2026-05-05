import { beforeEach, describe, expect, mock, test } from "bun:test";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AssistantConfig } from "../config/types.js";
import type { Provider, ProviderResponse } from "../providers/types.js";
import type { CommitContext } from "../workspace/commit-message-provider.js";

// ---------------------------------------------------------------------------
// Mock secure keys — controls what getSecureKeyAsync returns per provider
// ---------------------------------------------------------------------------
let mockSecureKeys: Record<string, string> = {};
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (name: string) => mockSecureKeys[name] ?? undefined,
  setSecureKeyAsync: async () => true,
  deleteSecureKeyAsync: async () => "deleted" as const,
}));

// ---------------------------------------------------------------------------
// Deep-clone a base config so each test can tweak fields independently
// ---------------------------------------------------------------------------
function cloneConfig(): AssistantConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.llm.default.provider = "anthropic";
  cfg.workspaceGit.commitMessageLLM = {
    ...cfg.workspaceGit.commitMessageLLM,
    enabled: true,
    timeoutMs: 5000,
    maxFilesInPrompt: 30,
    maxDiffBytes: 12000,
    minRemainingTurnBudgetMs: 1000,
    breaker: {
      openAfterFailures: 3,
      backoffBaseMs: 2000,
      backoffMaxMs: 60000,
    },
  };
  return cfg;
}

let currentConfig = cloneConfig();

// ---------------------------------------------------------------------------
// Mock: config/loader
// ---------------------------------------------------------------------------
mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
  loadConfig: () => currentConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

// ---------------------------------------------------------------------------
// Mock: providers/registry
// ---------------------------------------------------------------------------
const mockSendMessage = mock<Provider["sendMessage"]>();
const mockProvider: Provider = {
  name: "mock-provider",
  sendMessage: mockSendMessage,
};

let resolvedProvider: {
  provider: Provider;
  configuredProviderName: string;
} | null = {
  provider: mockProvider,
  configuredProviderName: "anthropic",
};

mock.module("../providers/provider-send-message.js", () => ({
  resolveConfiguredProvider: async () => resolvedProvider,
}));

// ---------------------------------------------------------------------------
// Mock: logger (noop)
// ---------------------------------------------------------------------------
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------
import {
  _resetCommitMessageGenerator,
  getCommitMessageGenerator,
} from "../workspace/provider-commit-message-generator.js";

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------
const baseContext: CommitContext = {
  workspaceDir: "/tmp/test",
  trigger: "turn" as const,
  conversationId: "sess_test",
  turnNumber: 1,
  changedFiles: ["file.txt"],
  timestampMs: Date.now(),
};

function makeSuccessResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
}

describe("ProviderCommitMessageGenerator", () => {
  beforeEach(() => {
    _resetCommitMessageGenerator();
    currentConfig = cloneConfig();
    mockSecureKeys = { anthropic: "sk-test-key" };
    mockSendMessage.mockReset();
    resolvedProvider = {
      provider: mockProvider,
      configuredProviderName: "anthropic",
    };
  });

  // 1. disabled
  test('disabled → returns deterministic, reason "disabled"', async () => {
    currentConfig.workspaceGit.commitMessageLLM.enabled = false;
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("deterministic");
    expect(result.reason).toBe("disabled");
  });

  // 3. missing API key
  test('missing API key → returns deterministic, reason "missing_provider_api_key"', async () => {
    mockSecureKeys = {};
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("deterministic");
    expect(result.reason).toBe("missing_provider_api_key");
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  // 3b. No resolvable provider and no keys
  test('no resolvable provider + no keys → returns deterministic, reason "missing_provider_api_key"', async () => {
    mockSecureKeys = {};
    resolvedProvider = null;
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("deterministic");
    expect(result.reason).toBe("missing_provider_api_key");
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  // 3c. No resolvable provider despite keys
  test('no resolvable provider with keys present → returns deterministic, reason "provider_not_initialized"', async () => {
    mockSecureKeys = { anthropic: "sk-test-key" };
    resolvedProvider = null;
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("deterministic");
    expect(result.reason).toBe("provider_not_initialized");
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  // 4. breaker open
  test('breaker open → returns deterministic, reason "breaker_open"', async () => {
    // Force the breaker open by simulating enough failures
    currentConfig.workspaceGit.commitMessageLLM.breaker.openAfterFailures = 1;
    const gen = getCommitMessageGenerator();

    // Trigger a failure to open the breaker — provider throws
    mockSendMessage.mockRejectedValueOnce(new Error("provider error"));
    await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });

    // Now the breaker should be open
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("deterministic");
    expect(result.reason).toBe("breaker_open");
  });

  // 5. insufficient budget
  test('insufficient budget → returns deterministic, reason "insufficient_budget"', async () => {
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
      deadlineMs: Date.now() - 1000, // already expired
    });
    expect(result.source).toBe("deterministic");
    expect(result.reason).toBe("insufficient_budget");
  });

  // 6. LLM success
  test('LLM success → returns LLM message, source "llm", callSite passed', async () => {
    const commitMsg = "feat: add new feature";
    mockSendMessage.mockResolvedValueOnce(makeSuccessResponse(commitMsg));
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("llm");
    expect(result.message).toBe(commitMsg);
    expect(result.reason).toBeUndefined();

    // Verify the callSite was passed so the provider's RetryProvider routes
    // through `resolveCallSiteConfig` for model/max_tokens/temperature.
    const callArgs = mockSendMessage.mock.calls[0];
    const options = callArgs[3] as {
      config: { callSite: string };
    };
    expect(options.config.callSite).toBe("commitMessage");
  });

  // 8. LLM timeout
  test('LLM timeout → returns deterministic, reason "timeout"', async () => {
    // Set a very short timeout and make sendMessage take too long
    currentConfig.workspaceGit.commitMessageLLM.timeoutMs = 1;
    mockSendMessage.mockImplementationOnce((_msgs, _tools, _sys, options) => {
      // Wait until the abort signal fires
      return new Promise<ProviderResponse>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("deterministic");
    expect(result.reason).toBe("timeout");
  });

  // 9. LLM provider error
  test('LLM provider error → returns deterministic, reason "provider_error"', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error("API error"));
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("deterministic");
    expect(result.reason).toBe("provider_error");
  });

  // 10. LLM invalid output (empty string)
  test('LLM invalid output (empty string) → returns deterministic, reason "invalid_output"', async () => {
    mockSendMessage.mockResolvedValueOnce(makeSuccessResponse(""));
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("deterministic");
    expect(result.reason).toBe("invalid_output");
  });

  // 11. LLM subject > 72 chars → truncated to 72, still source "llm"
  test('LLM subject > 72 chars → truncated to 72, source "llm"', async () => {
    const longSubject = "a".repeat(100);
    mockSendMessage.mockResolvedValueOnce(makeSuccessResponse(longSubject));
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("llm");
    expect(result.reason).toBeUndefined();
    expect(result.message.split("\n")[0].length).toBeLessThanOrEqual(72);
    expect(result.message).toBe("a".repeat(72));
  });

  // 11b. LLM subject > 72 chars with body → subject truncated, body preserved
  test("LLM subject > 72 chars with body → subject truncated, body preserved", async () => {
    const longSubject = "b".repeat(80);
    const body = "\n\n- bullet one\n- bullet two";
    mockSendMessage.mockResolvedValueOnce(
      makeSuccessResponse(longSubject + body),
    );
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("llm");
    expect(result.reason).toBeUndefined();
    expect(result.message.split("\n")[0].length).toBeLessThanOrEqual(72);
    expect(result.message).toBe("b".repeat(72) + body);
  });

  // 12. Ollama (keyless provider) — passes the API-key preflight even without
  // a stored secret, then succeeds because the call-site resolver supplies
  // the model from `llm.default`/`llm.callSites.commitMessage`.
  test("Ollama (keyless) — succeeds because call-site resolver supplies the model", async () => {
    currentConfig.llm.default.provider = "ollama";
    mockSecureKeys = {};
    resolvedProvider = {
      provider: mockProvider,
      configuredProviderName: "ollama",
    };
    const commitMsg = "fix: local model commit";
    mockSendMessage.mockResolvedValueOnce(makeSuccessResponse(commitMsg));
    const gen = getCommitMessageGenerator();
    const result = await gen.generateCommitMessage(baseContext, {
      changedFiles: baseContext.changedFiles,
    });
    expect(result.source).toBe("llm");
    expect(result.message).toBe(commitMsg);
    const callArgs = mockSendMessage.mock.calls[0];
    const options = callArgs[3] as { config: { callSite: string } };
    expect(options.config.callSite).toBe("commitMessage");
  });
});
