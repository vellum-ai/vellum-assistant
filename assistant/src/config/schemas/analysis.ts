import { z } from "zod";

export const AnalysisConfigSchema = z
  .object({
    // Number of new messages in the source conversation that trigger an
    // analysis enqueue. Defaults to 3× the extraction batch size so analysis
    // fires less often than extraction.
    batchSize: z
      .number({ error: "analysis.batchSize must be a number" })
      .int("analysis.batchSize must be an integer")
      .positive("analysis.batchSize must be a positive integer")
      .default(30)
      .describe(
        "Number of new messages in the source conversation that trigger an analysis enqueue",
      ),

    // Idle window after the last message before the debounced analysis
    // job fires. Defaults to 2× the extraction idle window.
    idleTimeoutMs: z
      .number({ error: "analysis.idleTimeoutMs must be a number" })
      .int("analysis.idleTimeoutMs must be an integer")
      .positive("analysis.idleTimeoutMs must be a positive integer")
      .default(600_000)
      .describe(
        "Milliseconds of idle time after the last message before the debounced analysis job fires",
      ),
  })
  .describe(
    "Controls the auto-analyze agent loop triggered by conversation activity. Model selection lives under llm.callSites.analyzeConversation.",
  );

export type AnalysisConfig = z.infer<typeof AnalysisConfigSchema>;
