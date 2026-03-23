import { getConfig } from "../config/loader.js";
import { resolveConfiguredProvider } from "../providers/provider-send-message.js";
import type { Message } from "../providers/types.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import type { CommitContext } from "./commit-message-provider.js";
import { DefaultCommitMessageProvider } from "./commit-message-provider.js";

const log = getLogger("commit-message-llm");

export type CommitMessageSource = "llm" | "deterministic";
export type LLMFallbackReason =
  | "disabled"
  | "missing_provider_api_key"
  | "breaker_open"
  | "insufficient_budget"
  | "missing_fast_model"
  | "provider_not_initialized"
  | "timeout"
  | "provider_error"
  | "invalid_output";

export interface GenerateCommitMessageResult {
  message: string;
  source: CommitMessageSource;
  reason?: LLMFallbackReason;
}

interface GenerateOptions {
  deadlineMs?: number;
  changedFiles: string[];
  diffSummary?: string;
}

const SYSTEM_PROMPT = `You generate concise git commit messages for workspace file changes.
Rules:
- Write a single short subject line (max 72 chars), optionally followed by a blank line and 2-4 concise bullet points
- No markdown headings or formatting
- Only mention files and changes actually provided
- Total output must be under 300 characters
- If you cannot determine a meaningful message, respond with exactly: FALLBACK`;

const PROVIDER_DEFAULT_FAST_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
};

// Providers that can be initialized without an API key (e.g., Ollama runs locally)
const KEYLESS_PROVIDERS = new Set(["ollama"]);

const deterministicProvider = new DefaultCommitMessageProvider();

function getProviderCandidates(config: ReturnType<typeof getConfig>): string[] {
  return [config.services.inference.provider];
}

function buildDeterministicResult(
  context: CommitContext,
  reason: LLMFallbackReason,
): GenerateCommitMessageResult {
  return {
    message: deterministicProvider.buildImmediateMessage(context).message,
    source: "deterministic",
    reason,
  };
}

export class ProviderCommitMessageGenerator {
  private consecutiveFailures = 0;
  private nextAllowedAttemptMs = 0;

  private isBreakerOpen(): boolean {
    const config = getConfig();
    const { openAfterFailures } = config.workspaceGit.commitMessageLLM.breaker;
    if (this.consecutiveFailures < openAfterFailures) return false;
    return Date.now() < this.nextAllowedAttemptMs;
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      log.info(
        { previousFailures: this.consecutiveFailures },
        "Commit message LLM breaker closed: succeeded after failures",
      );
    }
    this.consecutiveFailures = 0;
    this.nextAllowedAttemptMs = 0;
  }

  private recordFailure(): void {
    const config = getConfig();
    const { backoffBaseMs, backoffMaxMs } =
      config.workspaceGit.commitMessageLLM.breaker;
    this.consecutiveFailures++;
    const delay = Math.min(
      backoffBaseMs * Math.pow(2, this.consecutiveFailures - 1),
      backoffMaxMs,
    );
    this.nextAllowedAttemptMs = Date.now() + delay;
    log.warn(
      { consecutiveFailures: this.consecutiveFailures, backoffMs: delay },
      "Commit message LLM breaker opened: backing off",
    );
  }

  async generateCommitMessage(
    context: CommitContext,
    options: GenerateOptions,
  ): Promise<GenerateCommitMessageResult> {
    const config = getConfig();
    const llmConfig = config.workspaceGit.commitMessageLLM;

    // ── Fallback check order (canonical) ──────────────────────────────
    // 1. disabled
    // 2. resolve configured provider:
    //    - missing_provider_api_key OR provider_not_initialized
    // 3. selected-provider API key preflight (except keyless providers)
    // 4. breaker_open
    // 5. insufficient_budget
    // 6. missing_fast_model
    // 7. call provider → timeout / provider_error / invalid_output
    // ──────────────────────────────────────────────────────────────────

    // Step 1: Feature gate
    if (!llmConfig.enabled) {
      return buildDeterministicResult(context, "disabled");
    }
    if (!llmConfig.useConfiguredProvider) {
      return buildDeterministicResult(context, "disabled");
    }

    // Step 2: Resolve configured provider.
    // If nothing is resolvable, differentiate likely missing-key cases from
    // true registry/init failures.
    const resolved = await resolveConfiguredProvider();
    if (!resolved) {
      const candidates = getProviderCandidates(config);
      const hasAnyKeylessCandidate = candidates.some((name) =>
        KEYLESS_PROVIDERS.has(name),
      );
      const keyChecks = await Promise.all(
        candidates.map(async (name) => {
          const value = await getSecureKeyAsync(name);
          return typeof value === "string" && value.length > 0;
        }),
      );
      const hasAnyProviderKey = keyChecks.some(Boolean);
      if (!hasAnyKeylessCandidate && !hasAnyProviderKey) {
        log.debug(
          "No API keys available for configured/fallback providers; falling back to deterministic",
        );
        return buildDeterministicResult(context, "missing_provider_api_key");
      }
      log.debug(
        { provider: config.services.inference.provider },
        "Provider not initialized; falling back to deterministic",
      );
      return buildDeterministicResult(context, "provider_not_initialized");
    }

    const provider = resolved.provider;
    const providerName = resolved.configuredProviderName;

    // Step 2b: API key preflight for the configured provider (skip keyless).
    if (!KEYLESS_PROVIDERS.has(providerName)) {
      const providerApiKey = await getSecureKeyAsync(providerName);
      if (!providerApiKey) {
        log.debug(
          {
            provider: providerName,
          },
          "Provider API key missing; falling back to deterministic",
        );
        return buildDeterministicResult(context, "missing_provider_api_key");
      }
    }

    // Step 3: Circuit breaker
    if (this.isBreakerOpen()) {
      log.debug(
        { consecutiveFailures: this.consecutiveFailures },
        "Commit message LLM breaker open; falling back to deterministic",
      );
      return buildDeterministicResult(context, "breaker_open");
    }

    // Step 4: Budget check
    if (options.deadlineMs !== undefined) {
      const remaining = options.deadlineMs - Date.now();
      if (remaining < llmConfig.minRemainingTurnBudgetMs) {
        log.debug(
          {
            remainingMs: remaining,
            minBudgetMs: llmConfig.minRemainingTurnBudgetMs,
          },
          "Insufficient budget for LLM commit message",
        );
        return buildDeterministicResult(context, "insufficient_budget");
      }
    }

    // Step 5: Fast model preflight — resolve before any provider call
    const fastModel =
      llmConfig.providerFastModelOverrides[providerName] ??
      PROVIDER_DEFAULT_FAST_MODELS[providerName];

    if (!fastModel) {
      log.debug(
        {
          provider: providerName,
          configuredProvider: config.services.inference.provider,
        },
        "No fast model resolvable for provider; falling back to deterministic",
      );
      return buildDeterministicResult(context, "missing_fast_model");
    }

    // Step 6 + 7: Call the provider
    try {
      // Build prompt
      const fileList = options.changedFiles
        .slice(0, llmConfig.maxFilesInPrompt)
        .join("\n");
      const truncatedSuffix =
        options.changedFiles.length > llmConfig.maxFilesInPrompt
          ? `\n... and ${
              options.changedFiles.length - llmConfig.maxFilesInPrompt
            } more files`
          : "";

      let userText = `Changed files:\n${fileList}${truncatedSuffix}`;
      if (options.diffSummary) {
        const diffBytes = new TextEncoder().encode(options.diffSummary).length;
        const diff =
          diffBytes > llmConfig.maxDiffBytes
            ? new TextDecoder().decode(
                new TextEncoder()
                  .encode(options.diffSummary)
                  .slice(0, llmConfig.maxDiffBytes),
              ) + "\n... (truncated)"
            : options.diffSummary;
        userText += `\n\nDiff summary:\n${diff}`;
      }

      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: userText }],
        },
      ];

      // AbortController with timeout
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), llmConfig.timeoutMs);

      let response;
      try {
        response = await provider.sendMessage(
          messages,
          undefined,
          SYSTEM_PROMPT,
          {
            signal: ac.signal,
            config: {
              model: fastModel,
              max_tokens: llmConfig.maxTokens,
              temperature: llmConfig.temperature,
            },
          },
        );
      } catch (err: unknown) {
        clearTimeout(timer);
        if (ac.signal.aborted) {
          log.warn(
            "Commit message LLM timed out; falling back to deterministic",
          );
          this.recordFailure();
          return buildDeterministicResult(context, "timeout");
        }
        throw err;
      }
      clearTimeout(timer);

      // Extract text from response
      const textBlocks = response.content.filter((b) => b.type === "text");
      const text = textBlocks
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("")
        .trim();

      // Validate output
      if (!text || text === "FALLBACK" || text.length > 500) {
        log.debug(
          { outputLength: text?.length ?? 0, isFallback: text === "FALLBACK" },
          "LLM output invalid; falling back to deterministic",
        );
        this.recordFailure();
        return buildDeterministicResult(context, "invalid_output");
      }

      // Cap subject line to 72 chars deterministically (no fallback, no breaker failure)
      const lines = text.split("\n");
      if (lines[0].length > 72) {
        log.debug(
          { originalLength: lines[0].length },
          "Capping LLM subject line to 72 chars",
        );
        lines[0] = lines[0].slice(0, 72);
      }
      const finalMessage = lines.join("\n");

      this.recordSuccess();
      return { message: finalMessage, source: "llm" };
    } catch (err: unknown) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Commit message LLM provider error; falling back to deterministic",
      );
      this.recordFailure();
      return buildDeterministicResult(context, "provider_error");
    }
  }
}

let instance: ProviderCommitMessageGenerator | null = null;

export function getCommitMessageGenerator(): ProviderCommitMessageGenerator {
  if (!instance) {
    instance = new ProviderCommitMessageGenerator();
  }
  return instance;
}

export function _resetCommitMessageGenerator(): void {
  instance = null;
}
