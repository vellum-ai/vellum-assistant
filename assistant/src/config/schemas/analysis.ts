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

    // Optional model intent for the analysis agent loop. When omitted,
    // the analysis agent uses the same model as the main agent.
    // Accepted values match the main agent's model-intent vocabulary.
    modelIntent: z
      .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
        error: "analysis.modelIntent must be a valid model intent",
      })
      .optional()
      .describe(
        "Model selection strategy for the analysis agent loop — falls back to the main agent's model when omitted",
      ),

    // Optional explicit model override (provider/model string). Takes
    // precedence over modelIntent when both are set.
    modelOverride: z
      .string({ error: "analysis.modelOverride must be a string" })
      .optional()
      .describe(
        "Explicit model override (provider/model string) for the analysis agent loop — takes precedence over modelIntent when both are set",
      ),
  })
  .describe("Controls the auto-analyze agent loop triggered by conversation activity");

export type AnalysisConfig = z.infer<typeof AnalysisConfigSchema>;
