import { z } from "zod";

export const WorkspaceGitConfigSchema = z.object({
  turnCommitMaxWaitMs: z
    .number({ error: "workspaceGit.turnCommitMaxWaitMs must be a number" })
    .int("workspaceGit.turnCommitMaxWaitMs must be an integer")
    .positive("workspaceGit.turnCommitMaxWaitMs must be a positive integer")
    .default(4000),
  failureBackoffBaseMs: z
    .number({ error: "workspaceGit.failureBackoffBaseMs must be a number" })
    .int("workspaceGit.failureBackoffBaseMs must be an integer")
    .positive("workspaceGit.failureBackoffBaseMs must be a positive integer")
    .default(2000),
  failureBackoffMaxMs: z
    .number({ error: "workspaceGit.failureBackoffMaxMs must be a number" })
    .int("workspaceGit.failureBackoffMaxMs must be an integer")
    .positive("workspaceGit.failureBackoffMaxMs must be a positive integer")
    .default(60000),
  interactiveGitTimeoutMs: z
    .number({ error: "workspaceGit.interactiveGitTimeoutMs must be a number" })
    .int("workspaceGit.interactiveGitTimeoutMs must be an integer")
    .positive("workspaceGit.interactiveGitTimeoutMs must be a positive integer")
    .default(10000),
  enrichmentQueueSize: z
    .number({ error: "workspaceGit.enrichmentQueueSize must be a number" })
    .int("workspaceGit.enrichmentQueueSize must be an integer")
    .positive("workspaceGit.enrichmentQueueSize must be a positive integer")
    .default(50),
  enrichmentConcurrency: z
    .number({ error: "workspaceGit.enrichmentConcurrency must be a number" })
    .int("workspaceGit.enrichmentConcurrency must be an integer")
    .positive("workspaceGit.enrichmentConcurrency must be a positive integer")
    .default(1),
  enrichmentJobTimeoutMs: z
    .number({ error: "workspaceGit.enrichmentJobTimeoutMs must be a number" })
    .int("workspaceGit.enrichmentJobTimeoutMs must be an integer")
    .positive("workspaceGit.enrichmentJobTimeoutMs must be a positive integer")
    .default(30000),
  enrichmentMaxRetries: z
    .number({ error: "workspaceGit.enrichmentMaxRetries must be a number" })
    .int("workspaceGit.enrichmentMaxRetries must be an integer")
    .nonnegative("workspaceGit.enrichmentMaxRetries must be non-negative")
    .default(2),
  commitMessageLLM: z
    .object({
      enabled: z
        .boolean({
          error: "workspaceGit.commitMessageLLM.enabled must be a boolean",
        })
        .default(false),
      useConfiguredProvider: z
        .boolean({
          error:
            "workspaceGit.commitMessageLLM.useConfiguredProvider must be a boolean",
        })
        .default(true),
      providerFastModelOverrides: z
        .record(z.string(), z.string())
        .default({} as Record<string, string>),
      timeoutMs: z
        .number({
          error: "workspaceGit.commitMessageLLM.timeoutMs must be a number",
        })
        .int("workspaceGit.commitMessageLLM.timeoutMs must be an integer")
        .positive(
          "workspaceGit.commitMessageLLM.timeoutMs must be a positive integer",
        )
        .default(600),
      maxTokens: z
        .number({
          error: "workspaceGit.commitMessageLLM.maxTokens must be a number",
        })
        .int("workspaceGit.commitMessageLLM.maxTokens must be an integer")
        .positive(
          "workspaceGit.commitMessageLLM.maxTokens must be a positive integer",
        )
        .default(120),
      temperature: z
        .number({
          error: "workspaceGit.commitMessageLLM.temperature must be a number",
        })
        .min(0, "workspaceGit.commitMessageLLM.temperature must be >= 0")
        .max(2, "workspaceGit.commitMessageLLM.temperature must be <= 2")
        .default(0.2),
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
        .default(30),
      maxDiffBytes: z
        .number({
          error: "workspaceGit.commitMessageLLM.maxDiffBytes must be a number",
        })
        .int("workspaceGit.commitMessageLLM.maxDiffBytes must be an integer")
        .positive(
          "workspaceGit.commitMessageLLM.maxDiffBytes must be a positive integer",
        )
        .default(12000),
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
        .default(1000),
      breaker: z
        .object({
          openAfterFailures: z
            .number({
              error:
                "workspaceGit.commitMessageLLM.breaker.openAfterFailures must be a number",
            })
            .int()
            .positive()
            .default(3),
          backoffBaseMs: z
            .number({
              error:
                "workspaceGit.commitMessageLLM.breaker.backoffBaseMs must be a number",
            })
            .int()
            .positive()
            .default(2000),
          backoffMaxMs: z
            .number({
              error:
                "workspaceGit.commitMessageLLM.breaker.backoffMaxMs must be a number",
            })
            .int()
            .positive()
            .default(60000),
        })
        .default({
          openAfterFailures: 3,
          backoffBaseMs: 2000,
          backoffMaxMs: 60000,
        }),
    })
    .default({
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
    }),
});

export type WorkspaceGitConfig = z.infer<typeof WorkspaceGitConfigSchema>;
