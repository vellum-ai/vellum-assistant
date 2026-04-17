import { z } from "zod";

export const WorkspaceGitConfigSchema = z
  .object({
    turnCommitMaxWaitMs: z
      .number({ error: "workspaceGit.turnCommitMaxWaitMs must be a number" })
      .int("workspaceGit.turnCommitMaxWaitMs must be an integer")
      .positive("workspaceGit.turnCommitMaxWaitMs must be a positive integer")
      .default(4000)
      .describe(
        "Maximum time to wait for a turn-based auto-commit to complete (ms)",
      ),
    failureBackoffBaseMs: z
      .number({ error: "workspaceGit.failureBackoffBaseMs must be a number" })
      .int("workspaceGit.failureBackoffBaseMs must be an integer")
      .positive("workspaceGit.failureBackoffBaseMs must be a positive integer")
      .default(2000)
      .describe(
        "Base delay for exponential backoff after a git operation failure (ms)",
      ),
    failureBackoffMaxMs: z
      .number({ error: "workspaceGit.failureBackoffMaxMs must be a number" })
      .int("workspaceGit.failureBackoffMaxMs must be an integer")
      .positive("workspaceGit.failureBackoffMaxMs must be a positive integer")
      .default(60000)
      .describe(
        "Maximum delay for exponential backoff after a git operation failure (ms)",
      ),
    interactiveGitTimeoutMs: z
      .number({
        error: "workspaceGit.interactiveGitTimeoutMs must be a number",
      })
      .int("workspaceGit.interactiveGitTimeoutMs must be an integer")
      .positive(
        "workspaceGit.interactiveGitTimeoutMs must be a positive integer",
      )
      .default(10000)
      .describe(
        "Timeout for interactive git operations like status and diff (ms)",
      ),
    enrichmentQueueSize: z
      .number({ error: "workspaceGit.enrichmentQueueSize must be a number" })
      .int("workspaceGit.enrichmentQueueSize must be an integer")
      .positive("workspaceGit.enrichmentQueueSize must be a positive integer")
      .default(50)
      .describe(
        "Maximum number of pending commit enrichment jobs in the queue",
      ),
    enrichmentConcurrency: z
      .number({ error: "workspaceGit.enrichmentConcurrency must be a number" })
      .int("workspaceGit.enrichmentConcurrency must be an integer")
      .positive("workspaceGit.enrichmentConcurrency must be a positive integer")
      .default(1)
      .describe("Number of concurrent commit enrichment workers"),
    enrichmentJobTimeoutMs: z
      .number({ error: "workspaceGit.enrichmentJobTimeoutMs must be a number" })
      .int("workspaceGit.enrichmentJobTimeoutMs must be an integer")
      .positive(
        "workspaceGit.enrichmentJobTimeoutMs must be a positive integer",
      )
      .default(30000)
      .describe("Timeout for a single commit enrichment job (ms)"),
    enrichmentMaxRetries: z
      .number({ error: "workspaceGit.enrichmentMaxRetries must be a number" })
      .int("workspaceGit.enrichmentMaxRetries must be an integer")
      .nonnegative("workspaceGit.enrichmentMaxRetries must be non-negative")
      .default(2)
      .describe("Maximum retries for a failed commit enrichment job"),
    commitMessageLLM: z
      .object({
        enabled: z
          .boolean({
            error: "workspaceGit.commitMessageLLM.enabled must be a boolean",
          })
          .default(false)
          .describe("Whether to use an LLM to generate commit messages"),
        timeoutMs: z
          .number({
            error: "workspaceGit.commitMessageLLM.timeoutMs must be a number",
          })
          .int("workspaceGit.commitMessageLLM.timeoutMs must be an integer")
          .positive(
            "workspaceGit.commitMessageLLM.timeoutMs must be a positive integer",
          )
          .default(600)
          .describe("Timeout for LLM commit message generation (ms)"),
        maxFilesInPrompt: z
          .number({
            error:
              "workspaceGit.commitMessageLLM.maxFilesInPrompt must be a number",
          })
          .int(
            "workspaceGit.commitMessageLLM.maxFilesInPrompt must be an integer",
          )
          .positive(
            "workspaceGit.commitMessageLLM.maxFilesInPrompt must be a positive integer",
          )
          .default(30)
          .describe(
            "Maximum number of changed files to include in the LLM prompt",
          ),
        maxDiffBytes: z
          .number({
            error:
              "workspaceGit.commitMessageLLM.maxDiffBytes must be a number",
          })
          .int("workspaceGit.commitMessageLLM.maxDiffBytes must be an integer")
          .positive(
            "workspaceGit.commitMessageLLM.maxDiffBytes must be a positive integer",
          )
          .default(12000)
          .describe("Maximum diff size in bytes to include in the LLM prompt"),
        minRemainingTurnBudgetMs: z
          .number({
            error:
              "workspaceGit.commitMessageLLM.minRemainingTurnBudgetMs must be a number",
          })
          .int(
            "workspaceGit.commitMessageLLM.minRemainingTurnBudgetMs must be an integer",
          )
          .nonnegative(
            "workspaceGit.commitMessageLLM.minRemainingTurnBudgetMs must be non-negative",
          )
          .default(1000)
          .describe(
            "Minimum remaining turn budget required before attempting LLM commit message generation (ms)",
          ),
        breaker: z
          .object({
            openAfterFailures: z
              .number({
                error:
                  "workspaceGit.commitMessageLLM.breaker.openAfterFailures must be a number",
              })
              .int()
              .positive()
              .default(3)
              .describe(
                "Number of consecutive failures before the circuit breaker opens",
              ),
            backoffBaseMs: z
              .number({
                error:
                  "workspaceGit.commitMessageLLM.breaker.backoffBaseMs must be a number",
              })
              .int()
              .positive()
              .default(2000)
              .describe("Base delay for circuit breaker backoff (ms)"),
            backoffMaxMs: z
              .number({
                error:
                  "workspaceGit.commitMessageLLM.breaker.backoffMaxMs must be a number",
              })
              .int()
              .positive()
              .default(60000)
              .describe("Maximum delay for circuit breaker backoff (ms)"),
          })
          .default({
            openAfterFailures: 3,
            backoffBaseMs: 2000,
            backoffMaxMs: 60000,
          })
          .describe(
            "Circuit breaker settings to temporarily disable LLM commit messages after repeated failures",
          ),
      })
      .default({
        enabled: false,
        timeoutMs: 600,
        maxFilesInPrompt: 30,
        maxDiffBytes: 12000,
        minRemainingTurnBudgetMs: 1000,
        breaker: {
          openAfterFailures: 3,
          backoffBaseMs: 2000,
          backoffMaxMs: 60000,
        },
      })
      .describe(
        "LLM-powered commit message generation operational settings. Provider/model/maxTokens/temperature live under llm.callSites.commitMessage.",
      ),
  })
  .describe(
    "Workspace git integration — auto-commits, enrichment, and LLM-generated commit messages",
  );

export type WorkspaceGitConfig = z.infer<typeof WorkspaceGitConfigSchema>;
