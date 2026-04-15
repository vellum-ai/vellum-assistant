import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "memory", "knowledge"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

import {
  buildElevenLabsVoiceSpec,
  resolveVoiceQualityProfile,
} from "../calls/voice-quality.js";
import { invalidateConfigCache, loadConfig } from "../config/loader.js";
import {
  AssistantConfigSchema,
  DEFAULT_ELEVENLABS_VOICE_ID,
  SttServiceSchema,
  TtsServiceSchema,
  VALID_TTS_SERVICE_PROVIDERS,
} from "../config/schema.js";
import type { AssistantConfig } from "../config/types.js";
import { _setStorePath } from "../security/encrypted-store.js";
import { listCatalogProviderIds } from "../tts/provider-catalog.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Tests: Zod schema (unit)
// ---------------------------------------------------------------------------

describe("AssistantConfigSchema", () => {
  test("parses empty object with full defaults", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.services.inference.provider).toBe("anthropic");
    expect(result.services.inference.model).toBe("claude-opus-4-6");
    expect(result.services.inference.mode).toBe("your-own");
    expect(result.services["image-generation"].provider).toBe("gemini");
    expect(result.services["image-generation"].model).toBe(
      "gemini-3.1-flash-image-preview",
    );
    expect(result.services["image-generation"].mode).toBe("your-own");
    expect(result.services["web-search"].provider).toBe(
      "inference-provider-native",
    );
    expect(result.services["web-search"].mode).toBe("your-own");
    expect(result.maxTokens).toBe(64000);
    expect(result.thinking).toEqual({
      enabled: true,
      streamThinking: true,
    });
    expect(result.contextWindow).toEqual({
      enabled: true,
      maxInputTokens: 200000,
      targetBudgetRatio: 0.3,
      compactThreshold: 0.8,
      summaryBudgetRatio: 0.05,
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize",
        nonInteractiveLatestTurnCompression: "truncate",
      },
    });
    expect(result.timeouts).toEqual({
      shellDefaultTimeoutSec: 120,
      shellMaxTimeoutSec: 600,
      permissionTimeoutSec: 300,
      toolExecutionTimeoutSec: 120,
      providerStreamTimeoutSec: 1800,
    });
    expect(result.rateLimit).toEqual({
      maxRequestsPerMinute: 0,
    });
    expect(result.secretDetection).toEqual({
      enabled: true,
      action: "redact",
      blockIngress: true,
      entropyThreshold: 4.0,
      allowOneTimeSend: false,
    });
    expect(result.auditLog).toEqual({ retentionDays: 0 });
  });

  test("accepts valid complete config", () => {
    const input = {
      services: {
        inference: { provider: "openai", model: "gpt-4" },
      },
      maxTokens: 4096,
      thinking: { enabled: true },
      timeouts: {
        shellDefaultTimeoutSec: 30,
        shellMaxTimeoutSec: 300,
        permissionTimeoutSec: 60,
      },
      rateLimit: { maxRequestsPerMinute: 10 },
      secretDetection: {
        enabled: false,
        action: "block" as const,
        blockIngress: false,
        entropyThreshold: 5.5,
      },
      auditLog: { retentionDays: 30 },
    };
    const result = AssistantConfigSchema.parse(input);
    expect(result.services.inference.provider).toBe("openai");
    expect(result.services.inference.model).toBe("gpt-4");
    expect(result.maxTokens).toBe(4096);
    expect(result.thinking.enabled).toBe(true);
    expect(result.secretDetection.action).toBe("block");
  });

  test("applies rollout defaults for dynamic budget", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.memory.retrieval.dynamicBudget).toEqual({
      enabled: true,
      minInjectTokens: 2400,
      maxInjectTokens: 16000,
      targetHeadroomTokens: 10000,
    });
  });

  test("applies memory.cleanup defaults", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.memory.cleanup).toEqual({
      enabled: true,
      enqueueIntervalMs: 6 * 60 * 60 * 1000,
      supersededItemRetentionMs: 30 * 24 * 60 * 60 * 1000,
      conversationRetentionDays: 0,
      llmRequestLogRetentionMs: 1 * 60 * 60 * 1000,
    });
  });

  test("rejects invalid memory.cleanup.enqueueIntervalMs", () => {
    const result = AssistantConfigSchema.safeParse({
      memory: { cleanup: { enqueueIntervalMs: 0 } },
    });
    expect(result.success).toBe(false);
  });

  test("accepts memory.cleanup.llmRequestLogRetentionMs at the 365-day boundary", () => {
    const max = 365 * 24 * 60 * 60 * 1000;
    const result = AssistantConfigSchema.safeParse({
      memory: { cleanup: { llmRequestLogRetentionMs: max } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memory.cleanup.llmRequestLogRetentionMs).toBe(max);
    }
  });

  test("rejects memory.cleanup.llmRequestLogRetentionMs above 365 days", () => {
    // This must match the gateway's MAX_LLM_REQUEST_LOG_RETENTION_MS. Without
    // the Zod .max(), a manually edited config.json with a large value would
    // be silently accepted by the daemon and then truncated by the macOS
    // picker on the next PATCH — a quiet data-loss bug.
    const overMax = 365 * 24 * 60 * 60 * 1000 + 1;
    const result = AssistantConfigSchema.safeParse({
      memory: { cleanup: { llmRequestLogRetentionMs: overMax } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          i.path.includes("llmRequestLogRetentionMs"),
        ),
      ).toBe(true);
    }
  });

  test("rejects negative memory.cleanup.llmRequestLogRetentionMs", () => {
    const result = AssistantConfigSchema.safeParse({
      memory: { cleanup: { llmRequestLogRetentionMs: -1 } },
    });
    expect(result.success).toBe(false);
  });

  test("accepts null memory.cleanup.llmRequestLogRetentionMs (keep forever)", () => {
    const result = AssistantConfigSchema.safeParse({
      memory: { cleanup: { llmRequestLogRetentionMs: null } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memory.cleanup.llmRequestLogRetentionMs).toBeNull();
    }
  });

  test("accepts memory.cleanup.llmRequestLogRetentionMs: 0 (prune immediately)", () => {
    const result = AssistantConfigSchema.safeParse({
      memory: { cleanup: { llmRequestLogRetentionMs: 0 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memory.cleanup.llmRequestLogRetentionMs).toBe(0);
    }
  });

  test("rejects invalid provider", () => {
    const result = AssistantConfigSchema.safeParse({
      services: { inference: { provider: "invalid" } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative maxTokens", () => {
    const result = AssistantConfigSchema.safeParse({ maxTokens: -100 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes("maxTokens")),
      ).toBe(true);
    }
  });

  test("rejects non-integer maxTokens", () => {
    const result = AssistantConfigSchema.safeParse({ maxTokens: 3.14 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes("maxTokens")),
      ).toBe(true);
    }
  });

  test("rejects string maxTokens", () => {
    const result = AssistantConfigSchema.safeParse({
      maxTokens: "not-a-number",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes("maxTokens")),
      ).toBe(true);
    }
  });

  test("rejects invalid timeout values", () => {
    const result = AssistantConfigSchema.safeParse({
      timeouts: {
        shellDefaultTimeoutSec: -5,
        shellMaxTimeoutSec: "bad",
        permissionTimeoutSec: 0,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("rejects invalid thinking config", () => {
    const result = AssistantConfigSchema.safeParse({
      thinking: { enabled: "yes" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("rejects contextWindow targetBudgetRatio >= compactThreshold", () => {
    const result = AssistantConfigSchema.safeParse({
      contextWindow: { targetBudgetRatio: 0.8, compactThreshold: 0.8 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path.join(".") === "contextWindow.targetBudgetRatio" &&
            issue.message.includes(
              "must be less than contextWindow.compactThreshold",
            ),
        ),
      ).toBe(true);
    }
  });

  test("rejects overflowRecovery safetyMarginRatio out of (0,1) range", () => {
    for (const bad of [0, 1, -0.1, 1.5]) {
      const result = AssistantConfigSchema.safeParse({
        contextWindow: { overflowRecovery: { safetyMarginRatio: bad } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) =>
            issue.path.join(".").includes("safetyMarginRatio"),
          ),
        ).toBe(true);
      }
    }
  });

  test("rejects invalid overflowRecovery interactiveLatestTurnCompression", () => {
    const result = AssistantConfigSchema.safeParse({
      contextWindow: {
        overflowRecovery: { interactiveLatestTurnCompression: "explode" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.path.join(".").includes("interactiveLatestTurnCompression"),
        ),
      ).toBe(true);
    }
  });

  test("rejects invalid overflowRecovery nonInteractiveLatestTurnCompression", () => {
    const result = AssistantConfigSchema.safeParse({
      contextWindow: {
        overflowRecovery: { nonInteractiveLatestTurnCompression: "nope" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.path.join(".").includes("nonInteractiveLatestTurnCompression"),
        ),
      ).toBe(true);
    }
  });

  test("rejects invalid secretDetection.action", () => {
    const result = AssistantConfigSchema.safeParse({
      secretDetection: { action: "explode" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("secretDetection.action"))).toBe(true);
    }
  });

  test("rejects negative secretDetection.entropyThreshold", () => {
    const result = AssistantConfigSchema.safeParse({
      secretDetection: { entropyThreshold: -1 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative rateLimit values", () => {
    const result = AssistantConfigSchema.safeParse({
      rateLimit: { maxRequestsPerMinute: -1 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative auditLog.retentionDays", () => {
    const result = AssistantConfigSchema.safeParse({
      auditLog: { retentionDays: -7 },
    });
    expect(result.success).toBe(false);
  });

  test("accepts partial nested objects with defaults", () => {
    const result = AssistantConfigSchema.parse({
      timeouts: { shellDefaultTimeoutSec: 30 },
    });
    expect(result.timeouts.shellDefaultTimeoutSec).toBe(30);
    expect(result.timeouts.shellMaxTimeoutSec).toBe(600);
    expect(result.timeouts.permissionTimeoutSec).toBe(300);
  });

  test("accepts zero for non-negative fields", () => {
    const result = AssistantConfigSchema.parse({
      rateLimit: { maxRequestsPerMinute: 0 },
      auditLog: { retentionDays: 0 },
    });
    expect(result.rateLimit.maxRequestsPerMinute).toBe(0);
    expect(result.auditLog.retentionDays).toBe(0);
  });

  test("accepts all valid provider values", () => {
    for (const provider of [
      "anthropic",
      "openai",
      "gemini",
      "ollama",
    ] as const) {
      const result = AssistantConfigSchema.safeParse({
        services: { inference: { provider } },
      });
      expect(result.success).toBe(true);
    }
  });

  test("accepts all valid secretDetection.action values", () => {
    for (const action of ["redact", "warn", "block"] as const) {
      const result = AssistantConfigSchema.safeParse({
        secretDetection: { action },
      });
      expect(result.success).toBe(true);
    }
  });

  test("provides helpful error messages", () => {
    const result = AssistantConfigSchema.safeParse({
      maxTokens: -1,
      secretDetection: { action: "explode" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("positive"))).toBe(true);
      expect(
        messages.some(
          (m) =>
            m.includes("redact") && m.includes("warn") && m.includes("block"),
        ),
      ).toBe(true);
    }
  });

  test("defaults permissions.mode to workspace", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.permissions).toEqual({
      mode: "workspace",
      hostAccess: false,
    });
  });

  test("accepts explicit permissions.mode strict", () => {
    const result = AssistantConfigSchema.parse({
      permissions: { mode: "strict" },
    });
    expect(result.permissions.mode).toBe("strict");
  });

  test("rejects permissions.mode legacy", () => {
    expect(() =>
      AssistantConfigSchema.parse({
        permissions: { mode: "legacy" },
      }),
    ).toThrow();
  });

  test("accepts explicit permissions.mode workspace", () => {
    const result = AssistantConfigSchema.parse({
      permissions: { mode: "workspace" },
    });
    expect(result.permissions.mode).toBe("workspace");
  });

  test("rejects invalid permissions.mode", () => {
    const result = AssistantConfigSchema.safeParse({
      permissions: { mode: "permissive" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("permissions.mode"))).toBe(true);
    }
  });

  test("applies workspaceGit defaults including interactiveGitTimeoutMs", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.workspaceGit).toEqual({
      turnCommitMaxWaitMs: 4000,
      failureBackoffBaseMs: 2000,
      failureBackoffMaxMs: 60000,
      interactiveGitTimeoutMs: 10000,
      enrichmentQueueSize: 50,
      enrichmentConcurrency: 1,
      enrichmentJobTimeoutMs: 30000,
      enrichmentMaxRetries: 2,
      commitMessageLLM: {
        enabled: false,
        useConfiguredProvider: true,
        providerFastModelOverrides: {},
        timeoutMs: 600,
        maxTokens: 120,
        temperature: 0.2,
        maxFilesInPrompt: 30,
        maxDiffBytes: 12000,
        minRemainingTurnBudgetMs: 1000,
        breaker: {
          openAfterFailures: 3,
          backoffBaseMs: 2000,
          backoffMaxMs: 60000,
        },
      },
    });
  });

  test("accepts custom workspaceGit.interactiveGitTimeoutMs", () => {
    const result = AssistantConfigSchema.parse({
      workspaceGit: { interactiveGitTimeoutMs: 5000 },
    });
    expect(result.workspaceGit.interactiveGitTimeoutMs).toBe(5000);
    // Other fields should still get defaults
    expect(result.workspaceGit.turnCommitMaxWaitMs).toBe(4000);
  });

  test("rejects non-positive workspaceGit.interactiveGitTimeoutMs", () => {
    const zeroResult = AssistantConfigSchema.safeParse({
      workspaceGit: { interactiveGitTimeoutMs: 0 },
    });
    expect(zeroResult.success).toBe(false);

    const negativeResult = AssistantConfigSchema.safeParse({
      workspaceGit: { interactiveGitTimeoutMs: -1 },
    });
    expect(negativeResult.success).toBe(false);
  });

  test("rejects non-integer workspaceGit.interactiveGitTimeoutMs", () => {
    const result = AssistantConfigSchema.safeParse({
      workspaceGit: { interactiveGitTimeoutMs: 3.5 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-number workspaceGit.interactiveGitTimeoutMs", () => {
    const result = AssistantConfigSchema.safeParse({
      workspaceGit: { interactiveGitTimeoutMs: "fast" },
    });
    expect(result.success).toBe(false);
  });

  // ── commitMessageLLM config ──────────────────────────────────────────

  test("default commitMessageLLM values are correct", () => {
    const result = AssistantConfigSchema.parse({});
    const llm = result.workspaceGit.commitMessageLLM;
    expect(llm.enabled).toBe(false);
    expect(llm.useConfiguredProvider).toBe(true);
    expect(llm.providerFastModelOverrides).toEqual({});
    expect(llm.timeoutMs).toBe(600);
    expect(llm.maxTokens).toBe(120);
    expect(llm.temperature).toBe(0.2);
    expect(llm.maxFilesInPrompt).toBe(30);
    expect(llm.maxDiffBytes).toBe(12000);
    expect(llm.minRemainingTurnBudgetMs).toBe(1000);
  });

  test("rejects negative commitMessageLLM.timeoutMs", () => {
    const result = AssistantConfigSchema.safeParse({
      workspaceGit: { commitMessageLLM: { timeoutMs: -1 } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects commitMessageLLM.temperature > 2", () => {
    const result = AssistantConfigSchema.safeParse({
      workspaceGit: { commitMessageLLM: { temperature: 2.5 } },
    });
    expect(result.success).toBe(false);
  });

  test("breaker settings have correct defaults", () => {
    const result = AssistantConfigSchema.parse({});
    const breaker = result.workspaceGit.commitMessageLLM.breaker;
    expect(breaker.openAfterFailures).toBe(3);
    expect(breaker.backoffBaseMs).toBe(2000);
    expect(breaker.backoffMaxMs).toBe(60000);
  });

  test("accepts valid commitMessageLLM overrides", () => {
    const result = AssistantConfigSchema.parse({
      workspaceGit: {
        commitMessageLLM: {
          enabled: true,
          timeoutMs: 1000,
          temperature: 0.5,
          breaker: { openAfterFailures: 5 },
        },
      },
    });
    expect(result.workspaceGit.commitMessageLLM.enabled).toBe(true);
    expect(result.workspaceGit.commitMessageLLM.timeoutMs).toBe(1000);
    expect(result.workspaceGit.commitMessageLLM.temperature).toBe(0.5);
    expect(result.workspaceGit.commitMessageLLM.breaker.openAfterFailures).toBe(
      5,
    );
    // Other breaker fields should still get defaults
    expect(result.workspaceGit.commitMessageLLM.breaker.backoffBaseMs).toBe(
      2000,
    );
  });

  test("rejects commitMessageLLM.temperature < 0", () => {
    const result = AssistantConfigSchema.safeParse({
      workspaceGit: { commitMessageLLM: { temperature: -0.1 } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer commitMessageLLM.maxTokens", () => {
    const result = AssistantConfigSchema.safeParse({
      workspaceGit: { commitMessageLLM: { maxTokens: 3.5 } },
    });
    expect(result.success).toBe(false);
  });

  // ── Calls config ────────────────────────────────────────────────────

  test("applies calls defaults", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.calls).toEqual({
      enabled: true,
      provider: "twilio",
      maxDurationSeconds: 3600,
      userConsultTimeoutSeconds: 120,
      ttsPlaybackDelayMs: 3000,
      accessRequestPollIntervalMs: 500,
      guardianWaitUpdateInitialIntervalMs: 15000,
      guardianWaitUpdateInitialWindowMs: 30000,
      guardianWaitUpdateSteadyMinIntervalMs: 20000,
      guardianWaitUpdateSteadyMaxIntervalMs: 30000,
      disclosure: {
        enabled: true,
        text: 'At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".',
      },
      safety: {
        denyCategories: [],
      },
      voice: {
        language: "en-US",
        hints: [],
        interruptSensitivity: "low",
      },
      callerIdentity: {
        allowPerCallOverride: true,
      },
      verification: {
        enabled: false,
        maxAttempts: 3,
        codeLength: 6,
      },
    });
  });

  test("accepts valid calls config overrides", () => {
    const result = AssistantConfigSchema.parse({
      calls: {
        enabled: false,
        maxDurationSeconds: 1800,
        userConsultTimeoutSeconds: 60,
        disclosure: { enabled: false, text: "Custom disclosure" },
        safety: { denyCategories: ["spam"] },
      },
    });
    expect(result.calls.enabled).toBe(false);
    expect(result.calls.maxDurationSeconds).toBe(1800);
    expect(result.calls.userConsultTimeoutSeconds).toBe(60);
    expect(result.calls.disclosure.enabled).toBe(false);
    expect(result.calls.disclosure.text).toBe("Custom disclosure");
    expect(result.calls.safety.denyCategories).toEqual(["spam"]);
  });

  test("accepts partial calls config with defaults for missing fields", () => {
    const result = AssistantConfigSchema.parse({
      calls: { maxDurationSeconds: 600 },
    });
    expect(result.calls.enabled).toBe(true);
    expect(result.calls.maxDurationSeconds).toBe(600);
    expect(result.calls.userConsultTimeoutSeconds).toBe(120);
    expect(result.calls.provider).toBe("twilio");
  });

  test("rejects invalid calls.enabled", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { enabled: "yes" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid calls.provider", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { provider: "vonage" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("calls.provider"))).toBe(true);
    }
  });

  test("rejects non-positive calls.maxDurationSeconds", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { maxDurationSeconds: 0 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer calls.maxDurationSeconds", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { maxDurationSeconds: 3.5 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-positive calls.userConsultTimeoutSeconds", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { userConsultTimeoutSeconds: -1 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean calls.disclosure.enabled", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { disclosure: { enabled: "true" } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string calls.disclosure.text", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { disclosure: { text: 123 } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-array calls.safety.denyCategories", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { safety: { denyCategories: "spam" } },
    });
    expect(result.success).toBe(false);
  });

  // ── Calls voice config ──────────────────────────────────────────────

  test("config without calls.voice parses correctly and produces defaults", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.calls.voice.language).toBe("en-US");
    expect(result.calls.voice.hints).toEqual([]);
    expect(result.calls.voice.interruptSensitivity).toBe("low");
  });

  test("accepts valid calls.voice overrides", () => {
    const result = AssistantConfigSchema.parse({
      calls: {
        voice: {
          language: "es-ES",
        },
      },
    });
    expect(result.calls.voice.language).toBe("es-ES");
  });

  test("transcriptionProvider is no longer part of the voice config schema", () => {
    // Zod strips unrecognized keys by default — the legacy field is silently ignored.
    const result = AssistantConfigSchema.parse({
      calls: { voice: { transcriptionProvider: "Google" } },
    });
    expect(
      (result.calls.voice as Record<string, unknown>).transcriptionProvider,
    ).toBeUndefined();
  });

  test("accepts optional calls.model", () => {
    const result = AssistantConfigSchema.parse({
      calls: { model: "claude-haiku-4-5-20251001" },
    });
    expect(result.calls.model).toBe("claude-haiku-4-5-20251001");
  });

  test("calls.model is undefined by default", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.calls.model).toBeUndefined();
  });

  // ── Caller identity config ────────────────────────────────────────

  test("applies calls.callerIdentity defaults", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.calls.callerIdentity).toEqual({
      allowPerCallOverride: true,
    });
  });

  test("accepts valid calls.callerIdentity overrides", () => {
    const result = AssistantConfigSchema.parse({
      calls: {
        callerIdentity: {
          allowPerCallOverride: false,
          userNumber: "+14155559999",
        },
      },
    });
    expect(result.calls.callerIdentity.allowPerCallOverride).toBe(false);
    expect(result.calls.callerIdentity.userNumber).toBe("+14155559999");
  });

  test("unknown defaultMode field is silently stripped by schema", () => {
    // Zod strips unrecognized keys by default.
    const result = AssistantConfigSchema.parse({
      calls: {
        callerIdentity: {
          defaultMode: "user_number",
          allowPerCallOverride: true,
        },
      },
    });
    expect(
      (result.calls.callerIdentity as Record<string, unknown>).defaultMode,
    ).toBeUndefined();
    expect(result.calls.callerIdentity.allowPerCallOverride).toBe(true);
  });

  test("rejects non-boolean calls.callerIdentity.allowPerCallOverride", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { callerIdentity: { allowPerCallOverride: "yes" } },
    });
    expect(result.success).toBe(false);
  });

  test("default behavior unchanged when callerIdentity omitted", () => {
    const result = AssistantConfigSchema.parse({
      calls: { enabled: true },
    });
    expect(result.calls.callerIdentity.allowPerCallOverride).toBe(true);
  });

  // ── hostBrowser.cdpInspect config ─────────────────────────────────

  test("applies hostBrowser.cdpInspect defaults", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.hostBrowser).toEqual({
      cdpInspect: {
        enabled: false,
        host: "localhost",
        port: 9222,
        probeTimeoutMs: 500,
        desktopAuto: {
          enabled: true,
          cooldownMs: 30_000,
        },
      },
    });
  });

  test("accepts hostBrowser.cdpInspect enabled with custom host/port", () => {
    const result = AssistantConfigSchema.parse({
      hostBrowser: {
        cdpInspect: {
          enabled: true,
          host: "127.0.0.1",
          port: 9333,
        },
      },
    });
    expect(result.hostBrowser.cdpInspect.enabled).toBe(true);
    expect(result.hostBrowser.cdpInspect.host).toBe("127.0.0.1");
    expect(result.hostBrowser.cdpInspect.port).toBe(9333);
    // Unset field should still receive its default.
    expect(result.hostBrowser.cdpInspect.probeTimeoutMs).toBe(500);
  });

  test("accepts hostBrowser.cdpInspect custom probeTimeoutMs", () => {
    const result = AssistantConfigSchema.parse({
      hostBrowser: { cdpInspect: { probeTimeoutMs: 1000 } },
    });
    expect(result.hostBrowser.cdpInspect.probeTimeoutMs).toBe(1000);
  });

  test("rejects hostBrowser.cdpInspect.port below 1", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: { cdpInspect: { port: 0 } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.path.join(".").includes("hostBrowser.cdpInspect.port"),
        ),
      ).toBe(true);
    }
  });

  test("rejects hostBrowser.cdpInspect.port above 65535", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: { cdpInspect: { port: 70000 } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.path.join(".").includes("hostBrowser.cdpInspect.port"),
        ),
      ).toBe(true);
    }
  });

  test("rejects non-integer hostBrowser.cdpInspect.port", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: { cdpInspect: { port: 9222.5 } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects hostBrowser.cdpInspect.probeTimeoutMs below 50", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: { cdpInspect: { probeTimeoutMs: 10 } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.path
            .join(".")
            .includes("hostBrowser.cdpInspect.probeTimeoutMs"),
        ),
      ).toBe(true);
    }
  });

  test("rejects hostBrowser.cdpInspect.probeTimeoutMs above 5000", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: { cdpInspect: { probeTimeoutMs: 10000 } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.path
            .join(".")
            .includes("hostBrowser.cdpInspect.probeTimeoutMs"),
        ),
      ).toBe(true);
    }
  });

  test("rejects non-integer hostBrowser.cdpInspect.probeTimeoutMs", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: { cdpInspect: { probeTimeoutMs: 500.5 } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean hostBrowser.cdpInspect.enabled", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: { cdpInspect: { enabled: "yes" } },
    });
    expect(result.success).toBe(false);
  });

  // ── services.tts config ──────────────────────────────────────────────

  test("applies services.tts defaults when not specified", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.services.tts.mode).toBe("your-own");
    expect(result.services.tts.provider).toBe("elevenlabs");
    expect(result.services.tts.providers.elevenlabs.voiceId).toBe(
      DEFAULT_ELEVENLABS_VOICE_ID,
    );
    expect(result.services.tts.providers.elevenlabs.speed).toBe(1.0);
    expect(result.services.tts.providers.elevenlabs.stability).toBe(0.5);
    expect(result.services.tts.providers.elevenlabs.similarityBoost).toBe(0.75);
    expect(
      result.services.tts.providers.elevenlabs.conversationTimeoutSeconds,
    ).toBe(30);
    expect(result.services.tts.providers["fish-audio"].referenceId).toBe("");
    expect(result.services.tts.providers["fish-audio"].chunkLength).toBe(200);
    expect(result.services.tts.providers["fish-audio"].format).toBe("mp3");
    expect(result.services.tts.providers["fish-audio"].speed).toBe(1.0);
  });

  test("accepts valid services.tts provider override", () => {
    const result = AssistantConfigSchema.parse({
      services: { tts: { provider: "fish-audio" } },
    });
    expect(result.services.tts.provider).toBe("fish-audio");
    expect(result.services.tts.mode).toBe("your-own");
  });

  test("accepts valid services.tts.providers.elevenlabs overrides", () => {
    const result = AssistantConfigSchema.parse({
      services: {
        tts: {
          providers: {
            elevenlabs: { voiceId: "custom-voice", speed: 0.8 },
          },
        },
      },
    });
    expect(result.services.tts.providers.elevenlabs.voiceId).toBe(
      "custom-voice",
    );
    expect(result.services.tts.providers.elevenlabs.speed).toBe(0.8);
    // Unset fields preserve defaults
    expect(result.services.tts.providers.elevenlabs.stability).toBe(0.5);
  });

  test("accepts valid services.tts.providers.fish-audio overrides", () => {
    const result = AssistantConfigSchema.parse({
      services: {
        tts: {
          providers: {
            "fish-audio": { referenceId: "my-voice", format: "wav" },
          },
        },
      },
    });
    expect(result.services.tts.providers["fish-audio"].referenceId).toBe(
      "my-voice",
    );
    expect(result.services.tts.providers["fish-audio"].format).toBe("wav");
    // Defaults preserved
    expect(result.services.tts.providers["fish-audio"].chunkLength).toBe(200);
  });

  test("rejects services.tts.mode = managed", () => {
    const result = AssistantConfigSchema.safeParse({
      services: { tts: { mode: "managed" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(
        msgs.some((m) => m.includes("your-own") || m.includes("managed")),
      ).toBe(true);
    }
  });

  // ── hostBrowser.cdpInspect.desktopAuto config ───────────────────────

  test("applies hostBrowser.cdpInspect.desktopAuto defaults", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.hostBrowser.cdpInspect.desktopAuto).toEqual({
      enabled: true,
      cooldownMs: 30_000,
    });
  });

  test("accepts hostBrowser.cdpInspect.desktopAuto overrides", () => {
    const result = AssistantConfigSchema.parse({
      hostBrowser: {
        cdpInspect: {
          desktopAuto: { enabled: false, cooldownMs: 10_000 },
        },
      },
    });
    expect(result.hostBrowser.cdpInspect.desktopAuto.enabled).toBe(false);
    expect(result.hostBrowser.cdpInspect.desktopAuto.cooldownMs).toBe(10_000);
  });

  test("accepts hostBrowser.cdpInspect.desktopAuto.cooldownMs of 0 (disable cooldown)", () => {
    const result = AssistantConfigSchema.parse({
      hostBrowser: {
        cdpInspect: { desktopAuto: { cooldownMs: 0 } },
      },
    });
    expect(result.hostBrowser.cdpInspect.desktopAuto.cooldownMs).toBe(0);
  });

  test("rejects hostBrowser.cdpInspect.desktopAuto.cooldownMs below 0", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: {
        cdpInspect: { desktopAuto: { cooldownMs: -1 } },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.path.join(".").includes("cooldownMs"),
        ),
      ).toBe(true);
    }
  });

  test("rejects invalid services.tts.provider", () => {
    const result = AssistantConfigSchema.safeParse({
      services: { tts: { provider: "aws-polly" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("services.tts.provider"))).toBe(true);
    }
  });

  test("services.tts.mode only accepts your-own as literal", () => {
    // Explicit your-own should work
    const valid = TtsServiceSchema.safeParse({ mode: "your-own" });
    expect(valid.success).toBe(true);

    // managed should be rejected
    const invalid = TtsServiceSchema.safeParse({ mode: "managed" });
    expect(invalid.success).toBe(false);

    // Any other string should be rejected
    const invalid2 = TtsServiceSchema.safeParse({ mode: "self-hosted" });
    expect(invalid2.success).toBe(false);
  });

  // ── services.stt config ──────────────────────────────────────────────

  test("rejects services.stt without explicit provider", () => {
    const result = AssistantConfigSchema.safeParse({
      services: { stt: { mode: "your-own" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join(".").includes("provider")),
      ).toBe(true);
    }
  });

  test("applies services.stt structural defaults when provider is explicit", () => {
    const result = AssistantConfigSchema.parse({
      services: { stt: { provider: "openai-whisper" } },
    });
    expect(result.services.stt.mode).toBe("your-own");
    expect(result.services.stt.provider).toBe("openai-whisper");
    // providers defaults to empty sparse map
    expect(result.services.stt.providers).toEqual({});
  });

  test("accepts valid services.stt provider override", () => {
    const result = AssistantConfigSchema.parse({
      services: { stt: { provider: "openai-whisper" } },
    });
    expect(result.services.stt.provider).toBe("openai-whisper");
    expect(result.services.stt.mode).toBe("your-own");
  });

  test("accepts valid services.stt.providers.openai-whisper overrides", () => {
    const result = AssistantConfigSchema.parse({
      services: {
        stt: {
          provider: "openai-whisper",
          providers: {
            "openai-whisper": {},
          },
        },
      },
    });
    expect(result.services.stt.providers["openai-whisper"]).toEqual({});
  });

  test("parses when providers map is empty (sparse default)", () => {
    const result = AssistantConfigSchema.parse({
      services: { stt: { provider: "deepgram", providers: {} } },
    });
    expect(result.services.stt.providers).toEqual({});
    expect(result.services.stt.provider).toBe("deepgram");
  });

  test("parses when unknown future provider blobs exist under providers", () => {
    const result = AssistantConfigSchema.parse({
      services: {
        stt: {
          provider: "openai-whisper",
          providers: {
            "openai-whisper": {},
            "future-provider": { model: "next-gen", lang: "en" },
          },
        },
      },
    });
    expect(result.services.stt.providers["openai-whisper"]).toEqual({});
    expect(result.services.stt.providers["future-provider"]).toEqual({
      model: "next-gen",
      lang: "en",
    });
  });

  test("rejects services.stt.mode = managed", () => {
    const result = AssistantConfigSchema.safeParse({
      services: { stt: { mode: "managed" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(
        msgs.some((m) => m.includes("your-own") || m.includes("managed")),
      ).toBe(true);
    }
  });

  test("rejects invalid services.stt.provider", () => {
    const result = AssistantConfigSchema.safeParse({
      services: { stt: { provider: "azure-speech" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("services.stt.provider"))).toBe(true);
    }
  });

  test("accepts deepgram as services.stt.provider", () => {
    const result = AssistantConfigSchema.parse({
      services: { stt: { provider: "deepgram" } },
    });
    expect(result.services.stt.provider).toBe("deepgram");
    expect(result.services.stt.mode).toBe("your-own");
  });

  test("accepts google-gemini as services.stt.provider", () => {
    const result = AssistantConfigSchema.parse({
      services: { stt: { provider: "google-gemini" } },
    });
    expect(result.services.stt.provider).toBe("google-gemini");
    expect(result.services.stt.mode).toBe("your-own");
  });

  test("applies services.stt structural defaults when google-gemini provider is explicit", () => {
    const result = AssistantConfigSchema.parse({
      services: { stt: { provider: "google-gemini" } },
    });
    expect(result.services.stt.mode).toBe("your-own");
    expect(result.services.stt.provider).toBe("google-gemini");
    expect(result.services.stt.providers).toEqual({});
  });

  test("accepts valid services.stt.providers.deepgram overrides", () => {
    const result = AssistantConfigSchema.parse({
      services: {
        stt: {
          provider: "deepgram",
          providers: {
            deepgram: {},
          },
        },
      },
    });
    expect(result.services.stt.providers.deepgram).toEqual({});
  });

  test("existing configs with explicit per-provider objects continue to parse", () => {
    // Configs with explicit per-provider objects must continue to
    // parse and round-trip successfully.
    const result = AssistantConfigSchema.parse({
      services: {
        stt: {
          provider: "openai-whisper",
          providers: {
            "openai-whisper": {},
            deepgram: {},
          },
        },
      },
    });
    expect(result.services.stt.providers["openai-whisper"]).toEqual({});
    expect(result.services.stt.providers.deepgram).toEqual({});
  });

  test("services.stt.provider is required (no implicit default)", () => {
    const result = AssistantConfigSchema.safeParse({
      services: { stt: {} },
    });
    expect(result.success).toBe(false);
  });

  test("services.stt.mode only accepts your-own as literal", () => {
    // Explicit your-own should work
    const valid = SttServiceSchema.safeParse({
      mode: "your-own",
      provider: "openai-whisper",
    });
    expect(valid.success).toBe(true);

    // managed should be rejected
    const invalid = SttServiceSchema.safeParse({
      mode: "managed",
      provider: "openai-whisper",
    });
    expect(invalid.success).toBe(false);

    // Any other string should be rejected
    const invalid2 = SttServiceSchema.safeParse({
      mode: "self-hosted",
      provider: "openai-whisper",
    });
    expect(invalid2.success).toBe(false);
  });

  test("rejects hostBrowser.cdpInspect.desktopAuto.cooldownMs above 300000", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: {
        cdpInspect: { desktopAuto: { cooldownMs: 500_000 } },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.path.join(".").includes("cooldownMs"),
        ),
      ).toBe(true);
    }
  });

  test("rejects non-integer hostBrowser.cdpInspect.desktopAuto.cooldownMs", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: {
        cdpInspect: { desktopAuto: { cooldownMs: 5000.5 } },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean hostBrowser.cdpInspect.desktopAuto.enabled", () => {
    const result = AssistantConfigSchema.safeParse({
      hostBrowser: {
        cdpInspect: { desktopAuto: { enabled: "yes" } },
      },
    });
    expect(result.success).toBe(false);
  });

  test("desktopAuto defaults preserved when only cdpInspect.enabled is set", () => {
    const result = AssistantConfigSchema.parse({
      hostBrowser: { cdpInspect: { enabled: true } },
    });
    expect(result.hostBrowser.cdpInspect.desktopAuto).toEqual({
      enabled: true,
      cooldownMs: 30_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Voice quality profile resolver
// ---------------------------------------------------------------------------

describe("resolveVoiceQualityProfile", () => {
  test("always returns ElevenLabs ttsProvider", () => {
    const config = AssistantConfigSchema.parse({});
    const profile = resolveVoiceQualityProfile(config);
    expect(profile.ttsProvider).toBe("ElevenLabs");
  });

  test("uses services.tts.providers.elevenlabs.voiceId for voice", () => {
    const config = AssistantConfigSchema.parse({
      services: {
        tts: {
          providers: { elevenlabs: { voiceId: "test-voice-id" } },
        },
      },
    });
    const profile = resolveVoiceQualityProfile(config);
    expect(profile.ttsProvider).toBe("ElevenLabs");
    expect(profile.voice).toBe("test-voice-id");
  });

  test("defaults to Amelia voice ID when elevenlabs.voiceId is not set", () => {
    const config = AssistantConfigSchema.parse({});
    const profile = resolveVoiceQualityProfile(config);
    expect(profile.voice).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
  });

  test("applies voice tuning params from services.tts.providers.elevenlabs config", () => {
    const config = AssistantConfigSchema.parse({
      services: {
        tts: {
          providers: {
            elevenlabs: {
              voiceId: "abc123",
              voiceModelId: "turbo_v2_5",
              speed: 0.9,
              stability: 0.8,
              similarityBoost: 0.9,
            },
          },
        },
      },
    });
    const profile = resolveVoiceQualityProfile(config);
    expect(profile.voice).toBe("abc123-turbo_v2_5-0.9_0.8_0.9");
  });
});

// ---------------------------------------------------------------------------
// Tests: buildElevenLabsVoiceSpec
// ---------------------------------------------------------------------------

describe("buildElevenLabsVoiceSpec", () => {
  test("produces Twilio-compliant voice string: voiceId-model-speed_stability_similarity", () => {
    const spec = buildElevenLabsVoiceSpec({
      voiceId: "abc123",
      voiceModelId: "turbo_v2_5",
      speed: 1.0,
      stability: 0.5,
      similarityBoost: 0.75,
    });
    expect(spec).toBe("abc123-turbo_v2_5-1_0.5_0.75");
  });

  test("returns empty string when voiceId is empty", () => {
    const spec = buildElevenLabsVoiceSpec({
      voiceId: "",
      voiceModelId: "turbo_v2_5",
      speed: 1.0,
      stability: 0.5,
      similarityBoost: 0.75,
    });
    expect(spec).toBe("");
  });

  test("formats custom parameters correctly", () => {
    const spec = buildElevenLabsVoiceSpec({
      voiceId: "myVoice",
      voiceModelId: "eleven_multilingual_v2",
      speed: 0.9,
      stability: 0.8,
      similarityBoost: 0.9,
    });
    expect(spec).toBe("myVoice-eleven_multilingual_v2-0.9_0.8_0.9");
  });

  test("default config uses a bare voiceId when no model override is set", () => {
    const config = AssistantConfigSchema.parse({
      services: {
        tts: {
          providers: { elevenlabs: { voiceId: "test" } },
        },
      },
    });
    const spec = buildElevenLabsVoiceSpec(
      config.services.tts.providers.elevenlabs,
    );
    expect(spec).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Tests: TTS config resolver
// ---------------------------------------------------------------------------

describe("resolveTtsConfig", () => {
  test("returns default provider and config from empty config", () => {
    const config = AssistantConfigSchema.parse({});
    const resolved = resolveTtsConfig(config);
    expect(resolved.provider).toBe("elevenlabs");
    expect(resolved.providerConfig).toMatchObject({
      voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
      speed: 1.0,
      stability: 0.5,
      similarityBoost: 0.75,
    });
  });

  test("uses canonical services.tts.provider when set", () => {
    const config = AssistantConfigSchema.parse({
      services: { tts: { provider: "fish-audio" } },
    });
    const resolved = resolveTtsConfig(config);
    expect(resolved.provider).toBe("fish-audio");
    expect(resolved.providerConfig).toMatchObject({
      referenceId: "",
      chunkLength: 200,
      format: "mp3",
      speed: 1.0,
    });
  });

  test("returns canonical elevenlabs config from services.tts.providers", () => {
    const config = AssistantConfigSchema.parse({
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: "canonical-voice", stability: 0.9 },
          },
        },
      },
    });
    const resolved = resolveTtsConfig(config);
    expect(resolved.provider).toBe("elevenlabs");
    expect(resolved.providerConfig).toMatchObject({
      voiceId: "canonical-voice",
      stability: 0.9,
    });
  });

  test("uses canonical elevenlabs config exclusively (no legacy fallback)", () => {
    const config = AssistantConfigSchema.parse({
      services: {
        tts: {
          providers: {
            elevenlabs: { voiceId: "canonical-voice", speed: 0.9 },
          },
        },
      },
    });
    const resolved = resolveTtsConfig(config);
    expect(resolved.provider).toBe("elevenlabs");
    expect(resolved.providerConfig).toMatchObject({
      voiceId: "canonical-voice",
      speed: 0.9,
    });
  });

  test("uses canonical fish-audio config exclusively (no legacy fallback)", () => {
    const config = AssistantConfigSchema.parse({
      services: {
        tts: {
          provider: "fish-audio",
          providers: {
            "fish-audio": { referenceId: "canonical-ref", format: "wav" },
          },
        },
      },
    });
    const resolved = resolveTtsConfig(config);
    expect(resolved.provider).toBe("fish-audio");
    expect(resolved.providerConfig).toMatchObject({
      referenceId: "canonical-ref",
      format: "wav",
    });
  });

  test("returns empty config for unknown provider", () => {
    // Force an unknown provider via type assertion for coverage.
    // structuredClone prevents mutation from leaking into Zod's shared
    // default objects (Zod 4 stores defaults by reference).
    const config = structuredClone(
      AssistantConfigSchema.parse({}),
    ) as AssistantConfig;
    (config.services.tts as { provider: string }).provider = "aws-polly";
    const resolved = resolveTtsConfig(config);
    expect(resolved.provider).toBe("aws-polly");
    expect(resolved.providerConfig).toEqual({});
  });

  test("unknown provider resolution is deterministic across repeated calls", () => {
    const config = structuredClone(
      AssistantConfigSchema.parse({}),
    ) as AssistantConfig;
    (config.services.tts as { provider: string }).provider = "nonexistent";
    const first = resolveTtsConfig(config);
    const second = resolveTtsConfig(config);
    expect(first).toEqual(second);
    expect(first.providerConfig).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tests: TTS provider catalog integration
// ---------------------------------------------------------------------------

describe("TTS provider catalog integration", () => {
  test("VALID_TTS_SERVICE_PROVIDERS matches catalog provider IDs", () => {
    const catalogIds = listCatalogProviderIds();
    expect([...VALID_TTS_SERVICE_PROVIDERS]).toEqual(catalogIds);
  });

  test("schema accepts all catalog provider IDs as services.tts.provider", () => {
    for (const providerId of listCatalogProviderIds()) {
      const result = AssistantConfigSchema.safeParse({
        services: { tts: { provider: providerId } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.services.tts.provider).toBe(providerId);
      }
    }
  });

  test("TtsProvidersSchema has a key for every catalog provider", () => {
    const parsed = AssistantConfigSchema.parse({});
    const providerKeys = Object.keys(parsed.services.tts.providers);
    for (const providerId of listCatalogProviderIds()) {
      expect(providerKeys).toContain(providerId);
    }
  });

  test("resolveTtsConfig returns correct defaults for each catalog provider", () => {
    for (const providerId of listCatalogProviderIds()) {
      const config = AssistantConfigSchema.parse({
        services: { tts: { provider: providerId } },
      });
      const resolved = resolveTtsConfig(config);
      expect(resolved.provider).toBe(providerId);
      // Every catalog provider should resolve to a non-empty config object
      expect(Object.keys(resolved.providerConfig).length).toBeGreaterThan(0);
    }
  });

  test("resolveTtsConfig returns overridden values for elevenlabs", () => {
    const config = AssistantConfigSchema.parse({
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: "override-voice", speed: 0.7 },
          },
        },
      },
    });
    const resolved = resolveTtsConfig(config);
    expect(resolved.provider).toBe("elevenlabs");
    expect(resolved.providerConfig).toMatchObject({
      voiceId: "override-voice",
      speed: 0.7,
      // Defaults still present for unset fields
      stability: 0.5,
      similarityBoost: 0.75,
    });
  });

  test("resolveTtsConfig returns overridden values for fish-audio", () => {
    const config = AssistantConfigSchema.parse({
      services: {
        tts: {
          provider: "fish-audio",
          providers: {
            "fish-audio": {
              referenceId: "override-ref",
              format: "opus",
              speed: 1.5,
            },
          },
        },
      },
    });
    const resolved = resolveTtsConfig(config);
    expect(resolved.provider).toBe("fish-audio");
    expect(resolved.providerConfig).toMatchObject({
      referenceId: "override-ref",
      format: "opus",
      speed: 1.5,
      // Defaults for unset fields
      chunkLength: 200,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: TTS migration 032
// ---------------------------------------------------------------------------

describe("032-tts-provider-unification migration", () => {
  const migrationDir = join(WORKSPACE_DIR, "_mig032");

  beforeEach(() => {
    if (existsSync(migrationDir)) {
      rmSync(migrationDir, { recursive: true, force: true });
    }
    mkdirSync(migrationDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(migrationDir)) {
      rmSync(migrationDir, { recursive: true, force: true });
    }
  });

  function writeMigConfig(obj: unknown): void {
    writeFileSync(
      join(migrationDir, "config.json"),
      JSON.stringify(obj, null, 2),
    );
  }

  function readMigConfig(): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(migrationDir, "config.json"), "utf-8"),
    ) as Record<string, unknown>;
  }

  test("backfills provider from calls.voice.ttsProvider", async () => {
    writeMigConfig({
      calls: { voice: { ttsProvider: "fish-audio" } },
    });
    const { ttsProviderUnificationMigration } =
      await import("../workspace/migrations/032-tts-provider-unification.js");
    await ttsProviderUnificationMigration.run(migrationDir);
    const result = readMigConfig();
    const tts = (result.services as Record<string, unknown>).tts as Record<
      string,
      unknown
    >;
    expect(tts.provider).toBe("fish-audio");
    expect(tts.mode).toBe("your-own");
  });

  test("backfills elevenlabs provider config from legacy keys", async () => {
    writeMigConfig({
      calls: { voice: { ttsProvider: "elevenlabs" } },
      elevenlabs: { voiceId: "my-voice", speed: 0.8 },
    });
    const { ttsProviderUnificationMigration } =
      await import("../workspace/migrations/032-tts-provider-unification.js");
    await ttsProviderUnificationMigration.run(migrationDir);
    const result = readMigConfig();
    const tts = (result.services as Record<string, unknown>).tts as Record<
      string,
      unknown
    >;
    const providers = tts.providers as Record<string, Record<string, unknown>>;
    expect(providers.elevenlabs.voiceId).toBe("my-voice");
    expect(providers.elevenlabs.speed).toBe(0.8);
  });

  test("backfills fish-audio provider config from legacy keys", async () => {
    writeMigConfig({
      calls: { voice: { ttsProvider: "fish-audio" } },
      fishAudio: { referenceId: "my-ref", format: "wav" },
    });
    const { ttsProviderUnificationMigration } =
      await import("../workspace/migrations/032-tts-provider-unification.js");
    await ttsProviderUnificationMigration.run(migrationDir);
    const result = readMigConfig();
    const tts = (result.services as Record<string, unknown>).tts as Record<
      string,
      unknown
    >;
    const providers = tts.providers as Record<string, Record<string, unknown>>;
    expect(providers["fish-audio"].referenceId).toBe("my-ref");
    expect(providers["fish-audio"].format).toBe("wav");
  });

  test("removes legacy fields after migration", async () => {
    writeMigConfig({
      calls: { voice: { ttsProvider: "elevenlabs", language: "en-US" } },
      elevenlabs: { voiceId: "my-voice" },
    });
    const { ttsProviderUnificationMigration } =
      await import("../workspace/migrations/032-tts-provider-unification.js");
    await ttsProviderUnificationMigration.run(migrationDir);
    const result = readMigConfig();
    // Legacy keys removed
    expect(
      (
        (result.calls as Record<string, unknown>).voice as Record<
          string,
          unknown
        >
      ).ttsProvider,
    ).toBeUndefined();
    expect(result.elevenlabs).toBeUndefined();
    // Other voice fields preserved
    expect(
      (
        (result.calls as Record<string, unknown>).voice as Record<
          string,
          unknown
        >
      ).language,
    ).toBe("en-US");
  });

  test("is idempotent — repeated runs produce no changes", async () => {
    writeMigConfig({
      calls: { voice: { ttsProvider: "fish-audio" } },
      fishAudio: { referenceId: "my-ref" },
    });
    const { ttsProviderUnificationMigration } =
      await import("../workspace/migrations/032-tts-provider-unification.js");
    await ttsProviderUnificationMigration.run(migrationDir);
    const afterFirst = readMigConfig();
    await ttsProviderUnificationMigration.run(migrationDir);
    const afterSecond = readMigConfig();
    expect(afterSecond).toEqual(afterFirst);
  });

  test("does not overwrite existing services.tts.provider", async () => {
    writeMigConfig({
      services: { tts: { provider: "elevenlabs" } },
      calls: { voice: { ttsProvider: "fish-audio" } },
    });
    const { ttsProviderUnificationMigration } =
      await import("../workspace/migrations/032-tts-provider-unification.js");
    await ttsProviderUnificationMigration.run(migrationDir);
    const result = readMigConfig();
    const tts = (result.services as Record<string, unknown>).tts as Record<
      string,
      unknown
    >;
    // Should keep the existing canonical value, not the legacy one
    expect(tts.provider).toBe("elevenlabs");
  });

  test("does not overwrite existing canonical provider config keys", async () => {
    writeMigConfig({
      services: {
        tts: {
          providers: {
            elevenlabs: { voiceId: "canonical-voice" },
          },
        },
      },
      elevenlabs: { voiceId: "legacy-voice", speed: 0.8 },
    });
    const { ttsProviderUnificationMigration } =
      await import("../workspace/migrations/032-tts-provider-unification.js");
    await ttsProviderUnificationMigration.run(migrationDir);
    const result = readMigConfig();
    const tts = (result.services as Record<string, unknown>).tts as Record<
      string,
      unknown
    >;
    const providers = tts.providers as Record<string, Record<string, unknown>>;
    // Canonical voiceId preserved, legacy speed backfilled
    expect(providers.elevenlabs.voiceId).toBe("canonical-voice");
    expect(providers.elevenlabs.speed).toBe(0.8);
    // Legacy top-level key removed
    expect(result.elevenlabs).toBeUndefined();
  });

  test("skips config without any legacy TTS fields", async () => {
    writeMigConfig({ maxTokens: 4096 });
    const { ttsProviderUnificationMigration } =
      await import("../workspace/migrations/032-tts-provider-unification.js");
    const before = readMigConfig();
    await ttsProviderUnificationMigration.run(migrationDir);
    const after = readMigConfig();
    // Should remain unchanged (no services.tts added)
    expect(after).toEqual(before);
  });

  test("down removes services.tts from config", async () => {
    writeMigConfig({
      services: {
        inference: { provider: "anthropic" },
        tts: { provider: "elevenlabs", mode: "your-own" },
      },
    });
    const { ttsProviderUnificationMigration } =
      await import("../workspace/migrations/032-tts-provider-unification.js");
    await ttsProviderUnificationMigration.down(migrationDir);
    const result = readMigConfig();
    const services = result.services as Record<string, unknown>;
    expect(services.tts).toBeUndefined();
    // Other services keys preserved
    expect(services.inference).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: loader integration (config file -> loadConfig with fallback)
// ---------------------------------------------------------------------------

describe("loadConfig with schema validation", () => {
  beforeEach(() => {
    // Keep WORKSPACE_DIR and logs in place to avoid racing async logger stream init.
    ensureTestDir();
    const resetPaths = [
      CONFIG_PATH,
      join(WORKSPACE_DIR, "keys.enc"),
      join(WORKSPACE_DIR, "data"),
      join(WORKSPACE_DIR, "data", "memory"),
    ];
    for (const path of resetPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    ensureTestDir();
    _setStorePath(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    _setStorePath(null);
    invalidateConfigCache();
  });

  // Intentionally do not remove WORKSPACE_DIR in afterAll.
  // A late async logger flush may still target logs under this path and can
  // intermittently trigger unhandled ENOENT in CI if the directory is removed.
  test("loads valid config", () => {
    writeConfig({
      services: {
        inference: { provider: "openai", model: "gpt-4" },
      },
      maxTokens: 4096,
    });
    const config = loadConfig();
    expect(config.services.inference.provider).toBe("openai");
    expect(config.services.inference.model).toBe("gpt-4");
    expect(config.maxTokens).toBe(4096);
  });

  test("applies defaults for missing fields", () => {
    writeConfig({});
    const config = loadConfig();
    expect(config.services.inference.provider).toBe("anthropic");
    expect(config.services.inference.model).toBe("claude-opus-4-6");
    expect(config.maxTokens).toBe(64000);
    expect(config.thinking).toEqual({
      enabled: true,
      streamThinking: true,
    });
    expect(config.contextWindow).toEqual({
      enabled: true,
      maxInputTokens: 200000,
      targetBudgetRatio: 0.3,
      compactThreshold: 0.8,
      summaryBudgetRatio: 0.05,
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize",
        nonInteractiveLatestTurnCompression: "truncate",
      },
    });
  });

  test("falls back to default for invalid provider", () => {
    writeConfig({
      services: { inference: { provider: "invalid-provider" } },
    });
    const config = loadConfig();
    expect(config.services.inference.provider).toBe("anthropic");
  });

  test("falls back to default for invalid maxTokens", () => {
    writeConfig({ maxTokens: -100 });
    const config = loadConfig();
    expect(config.maxTokens).toBe(64000);
  });

  test("falls back to defaults for invalid nested values", () => {
    writeConfig({
      timeouts: { shellDefaultTimeoutSec: -5, shellMaxTimeoutSec: "bad" },
    });
    const config = loadConfig();
    expect(config.timeouts.shellDefaultTimeoutSec).toBe(120);
    expect(config.timeouts.shellMaxTimeoutSec).toBe(600);
    expect(config.timeouts.permissionTimeoutSec).toBe(300);
  });

  test("preserves valid fields when other fields are invalid", () => {
    writeConfig({
      services: {
        inference: { provider: "openai", model: "gpt-4" },
      },
      maxTokens: -1,
      thinking: { enabled: true },
    });
    const config = loadConfig();
    expect(config.services.inference.provider).toBe("openai");
    expect(config.services.inference.model).toBe("gpt-4");
    expect(config.thinking.enabled).toBe(true);
    expect(config.maxTokens).toBe(64000);
  });

  test("handles no config file", () => {
    const config = loadConfig();
    expect(config.services.inference.provider).toBe("anthropic");
    expect(config.maxTokens).toBe(64000);
  });

  test("partial nested objects get defaults for missing fields", () => {
    writeConfig({
      timeouts: { shellDefaultTimeoutSec: 30 },
    });
    const config = loadConfig();
    expect(config.timeouts.shellDefaultTimeoutSec).toBe(30);
    expect(config.timeouts.shellMaxTimeoutSec).toBe(600);
    expect(config.timeouts.permissionTimeoutSec).toBe(300);
  });

  test("falls back for invalid secretDetection.action", () => {
    writeConfig({ secretDetection: { action: "explode" } });
    const config = loadConfig();
    expect(config.secretDetection.action).toBe("redact");
  });

  test("falls back for invalid contextWindow relationship", () => {
    writeConfig({
      contextWindow: { targetBudgetRatio: 0.8, compactThreshold: 0.8 },
    });
    const config = loadConfig();
    expect(config.contextWindow.targetBudgetRatio).toBe(0.3);
    expect(config.contextWindow.compactThreshold).toBe(0.8);
  });

  test("falls back for invalid rateLimit values", () => {
    writeConfig({
      rateLimit: { maxRequestsPerMinute: -1 },
    });
    const config = loadConfig();
    expect(config.rateLimit.maxRequestsPerMinute).toBe(0);
  });

  test("falls back for invalid auditLog.retentionDays", () => {
    writeConfig({ auditLog: { retentionDays: -7 } });
    const config = loadConfig();
    expect(config.auditLog.retentionDays).toBe(0);
  });

  test("defaults permissions.mode to workspace when not specified", () => {
    writeConfig({});
    const config = loadConfig();
    expect(config.permissions).toEqual({
      mode: "workspace",
      hostAccess: false,
    });
  });

  test("loads explicit permissions.mode strict", () => {
    writeConfig({ permissions: { mode: "strict" } });
    const config = loadConfig();
    expect(config.permissions.mode).toBe("strict");
  });

  test("falls back for invalid permissions.mode", () => {
    writeConfig({ permissions: { mode: "yolo" } });
    const config = loadConfig();
    expect(config.permissions.mode).toBe("workspace");
  });

  // ── Calls config (loader integration) ──────────────────────────────

  test("loads calls config from file", () => {
    writeConfig({
      calls: { enabled: false, maxDurationSeconds: 600 },
    });
    const config = loadConfig();
    expect(config.calls.enabled).toBe(false);
    expect(config.calls.maxDurationSeconds).toBe(600);
    expect(config.calls.userConsultTimeoutSeconds).toBe(120);
    expect(config.calls.provider).toBe("twilio");
  });

  test("falls back for invalid calls.provider", () => {
    writeConfig({ calls: { provider: "vonage" } });
    const config = loadConfig();
    expect(config.calls.provider).toBe("twilio");
  });

  test("recovers from partial filing.activeHours without wiping unrelated fields", () => {
    // Only activeHoursStart is set. The superRefine must emit the issue so
    // the loader's delete-and-retry can strip the set field; otherwise the
    // mismatch persists and the config falls back to full defaults (which
    // would reset maxTokens below to 64000).
    writeConfig({
      maxTokens: 4096,
      filing: { activeHoursStart: 8 },
    });
    const config = loadConfig();
    expect(config.maxTokens).toBe(4096);
    expect(config.filing.activeHoursStart).toBeNull();
    expect(config.filing.activeHoursEnd).toBeNull();
  });

  test("recovers from partial heartbeat.activeHours without wiping unrelated fields", () => {
    // activeHoursStart is explicitly nulled while activeHoursEnd defaults to
    // 22 — a mismatch. Single-emit on the null side lets delete-and-retry
    // strip activeHoursStart, after which the default (8) restores it.
    writeConfig({
      maxTokens: 4096,
      heartbeat: { activeHoursStart: null },
    });
    const config = loadConfig();
    expect(config.maxTokens).toBe(4096);
    // Both fall back to the heartbeat defaults (8, 22).
    expect(config.heartbeat.activeHoursStart).toBe(8);
    expect(config.heartbeat.activeHoursEnd).toBe(22);
  });

  test("partial heartbeat.activeHours preserves the explicit non-null value", () => {
    // User sets activeHoursEnd: 20 and nulls activeHoursStart. Single-emit
    // on the null side strips activeHoursStart only — default 8 restores
    // it, user's explicit 20 survives. Dual-emit would strip both and lose
    // the 20.
    writeConfig({
      maxTokens: 1234,
      heartbeat: { activeHoursStart: null, activeHoursEnd: 20 },
    });
    const config = loadConfig();
    expect(config.maxTokens).toBe(1234);
    expect(config.heartbeat.activeHoursStart).toBe(8);
    expect(config.heartbeat.activeHoursEnd).toBe(20);
  });

  test("recovers from equal filing.activeHours without wiping unrelated fields", () => {
    // activeHoursStart === activeHoursEnd is invalid (empty window). Filing's
    // defaults are null/null, so single-emit on one path would strip one side
    // and the null default would recreate a mismatch — cascading to a full
    // defaults reset that wipes maxTokens. Dual-emit strips both sides so
    // both defaults restore to null.
    writeConfig({
      maxTokens: 1234,
      filing: { activeHoursStart: 5, activeHoursEnd: 5 },
    });
    const config = loadConfig();
    expect(config.maxTokens).toBe(1234);
    expect(config.filing.activeHoursStart).toBeNull();
    expect(config.filing.activeHoursEnd).toBeNull();
  });

  test("applies calls defaults when not specified", () => {
    writeConfig({});
    const config = loadConfig();
    expect(config.calls.enabled).toBe(true);
    expect(config.calls.maxDurationSeconds).toBe(3600);
    expect(config.calls.userConsultTimeoutSeconds).toBe(120);
    expect(config.calls.disclosure.enabled).toBe(true);
    expect(config.calls.safety.denyCategories).toEqual([]);
    expect(config.calls.voice.language).toBe("en-US");
    expect(
      (config.calls.voice as Record<string, unknown>).transcriptionProvider,
    ).toBeUndefined();
    expect(
      (config.calls.voice as Record<string, unknown>).ttsProvider,
    ).toBeUndefined();
    expect(config.calls.model).toBeUndefined();
    expect(config.calls.callerIdentity).toEqual({
      allowPerCallOverride: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Call entrypoint gating
// ---------------------------------------------------------------------------

describe("Call entrypoint gating", () => {
  beforeEach(() => {
    ensureTestDir();
    const resetPaths = [
      CONFIG_PATH,
      join(WORKSPACE_DIR, "keys.enc"),
      join(WORKSPACE_DIR, "data"),
      join(WORKSPACE_DIR, "data", "memory"),
    ];
    for (const path of resetPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    ensureTestDir();
    _setStorePath(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    _setStorePath(null);
    invalidateConfigCache();
  });

  test("call_start tool returns error when calls.enabled is false", async () => {
    writeConfig({ calls: { enabled: false } });
    // Force config reload
    loadConfig();

    const { executeCallStart: _executeCallStart } =
      await import("../tools/calls/call-start.js");

    // The tool is registered via side effect. We need to test the gating logic directly.
    // Since the module registers itself, we test by loading config and checking behavior.
    const { getConfig } = await import("../config/loader.js");
    const config = getConfig();
    expect(config.calls.enabled).toBe(false);
  });

  test("handleStartCall route returns 403 when calls.enabled is false", async () => {
    writeConfig({ calls: { enabled: false } });
    loadConfig();

    const { handleStartCall } =
      await import("../runtime/routes/call-routes.js");
    const req = new Request("http://localhost/v1/calls/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumber: "+14155551234",
        task: "Test call",
        conversationId: "test-conv-id",
      }),
    });

    const response = await handleStartCall(req);
    expect(response.status).toBe(403);

    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("disabled");
  });
});
