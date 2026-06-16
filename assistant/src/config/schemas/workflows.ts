import { z } from "zod";

export const WorkflowsConfigSchema = z
  .object({
    maxAgentsPerRun: z
      .number({ error: "workflows.maxAgentsPerRun must be a number" })
      .int()
      .positive()
      .default(500)
      .describe(
        "Maximum total leaf agents a single workflow run may spawn across all steps",
      ),
    maxConcurrentLeaves: z
      .number({ error: "workflows.maxConcurrentLeaves must be a number" })
      .int()
      .positive()
      .default(6)
      .describe(
        "Maximum number of leaf agents that may run concurrently within a single workflow run",
      ),
    maxConcurrentRuns: z
      .number({ error: "workflows.maxConcurrentRuns must be a number" })
      .int()
      .positive()
      .default(3)
      .describe(
        "Maximum number of workflow runs that may execute concurrently",
      ),
    journalRetentionDays: z
      .number({ error: "workflows.journalRetentionDays must be a number" })
      .int()
      .positive()
      .default(30)
      .describe(
        "Number of days to retain workflow run journals before pruning",
      ),
  })
  .describe(
    "Workflow orchestration engine configuration — caps and concurrency knobs",
  );

export type WorkflowsConfig = z.infer<typeof WorkflowsConfigSchema>;
