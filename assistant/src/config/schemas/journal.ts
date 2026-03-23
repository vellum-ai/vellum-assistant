import { z } from "zod";

export const JournalConfigSchema = z
  .object({
    contextWindowSize: z
      .number({ error: "journal.contextWindowSize must be a number" })
      .int("journal.contextWindowSize must be an integer")
      .min(0, "journal.contextWindowSize must be >= 0")
      .default(10)
      .describe(
        "Number of recent journal entries to include in context (0 to disable)",
      ),
  })
  .describe("Journal context window configuration");

export type JournalConfig = z.infer<typeof JournalConfigSchema>;
