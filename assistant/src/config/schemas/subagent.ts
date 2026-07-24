import { z } from "zod";

/**
 * Per-run iteration budget for subagent spawns.
 *
 * A subagent runs as an unattended background conversation whose tool-use loop
 * iterates LLM calls on its own. Late iterations carry the full accumulated
 * context, so a run that never stops re-reads a large cache on every call and
 * its cost grows super-linearly. Production data (Jul 2026) put the per-spawn
 * call count at p50 9, p90 36, p99 ~115, with a worst-case single spawn making
 * 293 calls that read 65.8M cache tokens ($15.99). These thresholds bound that
 * tail: a one-time soft nudge asks the agent to wrap up, and a hard cap ends the
 * run gracefully with a truncation notice so the parent can respawn to continue.
 */
export const SubagentConfigSchema = z
  .object({
    softNudgeAtCalls: z
      .number({ error: "subagent.softNudgeAtCalls must be a number" })
      .int("subagent.softNudgeAtCalls must be an integer")
      .positive("subagent.softNudgeAtCalls must be a positive integer")
      .default(60)
      .describe(
        "LLM-call count within one subagent run at which a one-time wrap-up nudge is injected into the loop, telling the agent its iteration budget is nearly exhausted and it should return its best result now. Must be <= maxCallsPerRun. p99 of production subagent runs is ~115 calls, so a soft nudge at 60 lands well before the cap for the runaway tail while leaving typical runs (p50 9, p90 36) untouched.",
      ),
    maxCallsPerRun: z
      .number({ error: "subagent.maxCallsPerRun must be a number" })
      .int("subagent.maxCallsPerRun must be an integer")
      .positive("subagent.maxCallsPerRun must be a positive integer")
      .default(100)
      .describe(
        "Hard ceiling on LLM calls within one subagent run. When reached, the loop stops gracefully — the run completes with whatever the agent last produced plus a truncation notice so the parent can respawn to continue. A cost backstop, not a normal exit: p99 of production runs is ~115 calls and the extreme tail reached 293 calls in one spawn ($15.99), so 100 bounds cost while leaving typical runs (p50 9, p90 36) untouched.",
      ),
  })
  .describe(
    "Per-run iteration budget for subagent spawns (soft wrap-up nudge + hard cap as a cost backstop).",
  )
  .superRefine((config, ctx) => {
    if (config.softNudgeAtCalls > config.maxCallsPerRun) {
      // Emit on both fields so the loader's delete-and-retry strips both sides
      // in one pass rather than cascading to a full-defaults reset.
      const message =
        "subagent.softNudgeAtCalls must be <= subagent.maxCallsPerRun";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["softNudgeAtCalls"],
        message,
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxCallsPerRun"],
        message,
      });
    }
  });

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;
