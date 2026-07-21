import { z } from "zod";

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
        "Controls how conversations left mid-turn by a previous shutdown are handled on startup. Their stale processing flags are always cleared so they come up idle. When true, the assistant additionally resumes each interrupted turn in the background after startup completes, at most 2 consecutive times per conversation (the budget refills whenever a turn completes cleanly) so a turn that repeatedly interrupts the process is eventually left idle.",
      ),
  })
  .describe("Conversation behavior configuration");

export type ConversationsConfig = z.infer<typeof ConversationsConfigSchema>;
