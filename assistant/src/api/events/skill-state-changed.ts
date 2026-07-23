/**
 * `skills_state_changed` SSE event.
 *
 * Server → client broadcast emitted when a skill's install/enable state
 * changes (enable / disable / install / uninstall), so clients refresh
 * their skill list in lock-step. Identifies the skill by `name`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const SkillStateChangedEventSchema = z.object({
  type: z.literal("skills_state_changed"),
  name: z.string(),
  state: z.enum(["enabled", "disabled", "installed", "uninstalled"]),
});

export type SkillStateChangedEvent = z.infer<
  typeof SkillStateChangedEventSchema
>;
