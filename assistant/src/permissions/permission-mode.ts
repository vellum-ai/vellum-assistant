import { z } from "zod";

/**
 * Two-axis permission model:
 * - `askBeforeActing` — LLM behavior toggle: when true the assistant checks in
 *   with the user before taking actions.
 * - `hostAccess` — System-enforced gate: when true the assistant can execute
 *   commands on the host machine without prompting.
 */
export type PermissionMode = {
  askBeforeActing: boolean;
  hostAccess: boolean;
};

export const DEFAULT_PERMISSION_MODE: PermissionMode = {
  askBeforeActing: true,
  hostAccess: false,
};

export const PermissionModeSchema = z.object({
  askBeforeActing: z
    .boolean({ error: "permissionMode.askBeforeActing must be a boolean" })
    .default(true)
    .describe("Whether the assistant should check in before taking actions"),
  hostAccess: z
    .boolean({ error: "permissionMode.hostAccess must be a boolean" })
    .default(false)
    .describe(
      "Whether the assistant can execute commands on the host machine without prompting",
    ),
});
