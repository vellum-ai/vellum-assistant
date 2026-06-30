import { z } from "zod";

const StaleProcessingReaperConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "conversations.staleProcessingReaper.enabled must be a boolean",
      })
      .default(true)
      .describe(
        "When true, a periodic sweep clears processing flags left set by turns that died without reaching their cleanup path while the daemon kept running. The startup reset only catches flags stranded by a previous process; this catches them mid-process. Disable to fall back to startup-only clearing.",
      ),
    ceilingMs: z
      .number({
        error: "conversations.staleProcessingReaper.ceilingMs must be a number",
      })
      .int("conversations.staleProcessingReaper.ceilingMs must be an integer")
      .min(
        60_000,
        "conversations.staleProcessingReaper.ceilingMs must be >= 60000 (1 minute) to avoid reaping live turns",
      )
      .default(30 * 60_000)
      .describe(
        "Maximum age (ms) a conversation's processing flag may reach before the reaper treats it as stale. Set well above the longest plausible turn so a genuinely long run is never reaped mid-flight; the default is 30 minutes.",
      ),
    sweepIntervalMs: z
      .number({
        error:
          "conversations.staleProcessingReaper.sweepIntervalMs must be a number",
      })
      .int(
        "conversations.staleProcessingReaper.sweepIntervalMs must be an integer",
      )
      .min(
        10_000,
        "conversations.staleProcessingReaper.sweepIntervalMs must be >= 10000 (10 seconds)",
      )
      .default(60_000)
      .describe(
        "Interval (ms) between reaper sweeps. A flag over the ceiling is first nudged with a graceful abort, then force-cleared only if it survives a full interval — so this also governs the grace window a genuinely live over-ceiling turn gets to unwind on its own before being force-cleared.",
      ),
  })
  .describe(
    "Running-daemon backstop that clears processing flags stranded by turns that died without clearing their own flag.",
  );

export const ConversationsConfigSchema = z
  .object({
    skipAutoRetitling: z
      .boolean({
        error: "conversations.skipAutoRetitling must be a boolean",
      })
      .default(false)
      .describe(
        "When true, skip the second-pass title regeneration that fires after the third user turn. The initial auto-generated title and manual renames are unaffected.",
      ),
    backgroundInjection: z
      .string({
        error: "conversations.backgroundInjection must be a string",
      })
      .default(
        "This is a background turn — your guardian isn't watching. If anything noteworthy comes up, send them a notification so they see it when they're back by invoking the `notifications` skill (`assistant notifications send --message \"...\"`)",
      )
      .describe(
        "Inner text injected into the tail user message of non-interactive turns in background/scheduled conversations. The injector wraps this in <background_turn>...</background_turn> tags. Empty string disables the injection.",
      ),
    resumeProcessingOnStartup: z
      .boolean({
        error: "conversations.resumeProcessingOnStartup must be a boolean",
      })
      .default(false)
      .describe(
        "Controls how conversations left mid-turn by a previous shutdown are handled on startup. When false (default), their stale processing flag is cleared so they come up idle. When true, the daemon will instead automatically resume the interrupted turn for each such conversation.",
      ),
    staleProcessingReaper: StaleProcessingReaperConfigSchema.default(
      StaleProcessingReaperConfigSchema.parse({}),
    ),
  })
  .describe("Conversation behavior configuration");

export type ConversationsConfig = z.infer<typeof ConversationsConfigSchema>;
