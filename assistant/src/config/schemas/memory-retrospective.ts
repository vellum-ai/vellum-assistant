import { z } from "zod";

export const MemoryRetrospectiveConfigSchema = z
  .object({
    timeThresholdMs: z
      .number({
        error: "memory.retrospective.timeThresholdMs must be a number",
      })
      .int("memory.retrospective.timeThresholdMs must be an integer")
      .positive(
        "memory.retrospective.timeThresholdMs must be a positive integer",
      )
      .default(30 * 60 * 1000)
      .describe(
        "Milliseconds since the last retrospective attempt before the interval trigger fires.",
      ),

    messageThreshold: z
      .number({
        error: "memory.retrospective.messageThreshold must be a number",
      })
      .int("memory.retrospective.messageThreshold must be an integer")
      .positive(
        "memory.retrospective.messageThreshold must be a positive integer",
      )
      .default(10)
      .describe(
        "New messages since the last successful retrospective run before the message-count trigger fires.",
      ),

    minCooldownMs: z
      .number({ error: "memory.retrospective.minCooldownMs must be a number" })
      .int("memory.retrospective.minCooldownMs must be an integer")
      .nonnegative(
        "memory.retrospective.minCooldownMs must be a non-negative integer",
      )
      .default(5 * 60 * 1000)
      .describe(
        "Minimum milliseconds between attempts (success or failure). Prevents tight retry loops across trigger types. Pre-compaction bypasses this gate.",
      ),

    keepSupersededRuns: z
      .boolean({
        error: "memory.retrospective.keepSupersededRuns must be a boolean",
      })
      .default(false)
      .describe(
        "When false (default), superseded retrospective conversations are deleted once a newer run succeeds — the persisted remembered_log on memory_retrospective_state is the dedup baseline (the most recent run is scanned only as a fallback for state rows that predate the log column), so older runs are dead weight (fork-based runs each carry a full copy of the source conversation's messages). Operators who want to retain the full run history set this to true; retained runs also skip the startup orphan sweep so they survive restarts.",
      ),

    matchConversationProfile: z
      .boolean({
        error:
          "memory.retrospective.matchConversationProfile must be a boolean",
      })
      .default(false)
      .describe(
        "When true, fork-based retrospectives run under the source conversation's inference profile (which forkConversation copies onto the fork) instead of the call site's default. Provider prompt caches are byte-exact prefix matches scoped per model, and a thinking enable/disable mismatch invalidates the messages cache tier — so reusing the source's cached prefix requires the retrospective to resolve the SAME model/thinking/effort as the conversation's own turns. Falls back to the call site's default when the conversation has no profile or the referenced profile no longer exists.",
      ),

    promptPath: z
      .string({ error: "memory.retrospective.promptPath must be a string" })
      .nullable()
      .default(null)
      .describe(
        "Optional path to a file whose contents replace the bundled retrospective fork-instruction prompt. Absolute paths are used as-is, a leading `~/` is expanded to the home directory, otherwise the path is resolved under the workspace root. The loaded contents may include `{{AVAILABLE_TOOLS_LINE}}`, `{{WINDOW_ANCHOR}}`, `{{ALREADY_REMEMBERED}}`, and `{{SKILL_AUTHORING_SECTION}}`, which are substituted at runtime. If the file is missing, unreadable, or empty, the bundled prompt is used and a warning is logged.",
      ),
  })
  .describe(
    "Controls the memory-retrospective background pass. Model selection lives under llm.callSites.memoryRetrospective.",
  );

export type MemoryRetrospectiveConfig = z.infer<
  typeof MemoryRetrospectiveConfigSchema
>;
