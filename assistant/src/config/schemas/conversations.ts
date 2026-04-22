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
  })
  .describe("Conversation behavior configuration");

export type ConversationsConfig = z.infer<typeof ConversationsConfigSchema>;
