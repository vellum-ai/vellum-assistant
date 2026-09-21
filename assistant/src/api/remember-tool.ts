import { z } from "zod";

/**
 * The `remember` tool's input: what the daemon parses a call with, and what a
 * client reads a recorded call's input with. `content` is one fact or a list
 * of them. `finish_turn` yields the turn only when it is `true`; any other
 * value reads as absent. Unknown keys, such as the injected `activity`, pass
 * through.
 */
export const RememberInputSchema = z.looseObject({
  content: z.union([z.string(), z.array(z.string()).min(1)]),
  finish_turn: z.boolean().optional().catch(undefined),
});

export type RememberInput = z.infer<typeof RememberInputSchema>;
