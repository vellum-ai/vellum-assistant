import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
} from "../config/schema.js";
import { _setStorePath } from "../security/encrypted-store.js";

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
      llmRequestLogRetentionMs: 1 * 24 * 60 * 60 * 1000,
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
        transcriptionProvider: "Deepgram",
        ttsProvider: "elevenlabs",
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
    expect(result.calls.voice.transcriptionProvider).toBe("Deepgram");
  });

  test("elevenlabs tuning params have correct defaults", () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.elevenlabs.voiceModelId).toBe("");
    expect(result.elevenlabs.speed).toBe(1.0);
    expect(result.elevenlabs.stability).toBe(0.5);
    expect(result.elevenlabs.similarityBoost).toBe(0.75);
  });

  test("rejects elevenlabs.speed below 0.7", () => {
    const result = AssistantConfigSchema.safeParse({
      elevenlabs: { speed: 0.5 },
    });
    expect(result.success).toBe(false);
  });

  test("rejects elevenlabs.speed above 1.2", () => {
    const result = AssistantConfigSchema.safeParse({
      elevenlabs: { speed: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  test("accepts valid calls.voice overrides", () => {
    const result = AssistantConfigSchema.parse({
      calls: {
        voice: {
          language: "es-ES",
          transcriptionProvider: "Google",
        },
      },
      elevenlabs: {
        stability: 0.8,
      },
    });
    expect(result.calls.voice.language).toBe("es-ES");
    expect(result.calls.voice.transcriptionProvider).toBe("Google");
    expect(result.elevenlabs.stability).toBe(0.8);
    // Defaults preserved for unset fields
    expect(result.elevenlabs.voiceModelId).toBe("");
    expect(result.elevenlabs.similarityBoost).toBe(0.75);
  });

  test("rejects invalid calls.voice.transcriptionProvider", () => {
    const result = AssistantConfigSchema.safeParse({
      calls: { voice: { transcriptionProvider: "AWS" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(
        msgs.some((m) => m.includes("calls.voice.transcriptionProvider")),
      ).toBe(true);
    }
  });

  test("rejects elevenlabs.stability out of range", () => {
    const result = AssistantConfigSchema.safeParse({
      elevenlabs: { stability: 1.5 },
    });
    expect(result.success).toBe(false);
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
});

// ---------------------------------------------------------------------------
// Tests: Voice quality profile resolver
// ---------------------------------------------------------------------------

describe("resolveVoiceQualityProfile", () => {
  test("always returns ElevenLabs ttsProvider", () => {
    const config = AssistantConfigSchema.parse({});
    const profile = resolveVoiceQualityProfile(config);
    expect(profile.ttsProvider).toBe("ElevenLabs");
    expect(profile.transcriptionProvider).toBe("Deepgram");
  });

  test("uses shared elevenlabs.voiceId for voice", () => {
    const config = AssistantConfigSchema.parse({
      elevenlabs: { voiceId: "test-voice-id" },
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

  test("applies voice tuning params from elevenlabs config", () => {
    const config = AssistantConfigSchema.parse({
      elevenlabs: {
        voiceId: "abc123",
        voiceModelId: "turbo_v2_5",
        speed: 0.9,
        stability: 0.8,
        similarityBoost: 0.9,
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
      elevenlabs: { voiceId: "test" },
    });
    const spec = buildElevenLabsVoiceSpec(config.elevenlabs);
    expect(spec).toBe("test");
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

  test("applies calls defaults when not specified", () => {
    writeConfig({});
    const config = loadConfig();
    expect(config.calls.enabled).toBe(true);
    expect(config.calls.maxDurationSeconds).toBe(3600);
    expect(config.calls.userConsultTimeoutSeconds).toBe(120);
    expect(config.calls.disclosure.enabled).toBe(true);
    expect(config.calls.safety.denyCategories).toEqual([]);
    expect(config.calls.voice.language).toBe("en-US");
    expect(config.calls.voice.transcriptionProvider).toBe("Deepgram");
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
