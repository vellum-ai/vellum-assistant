import { z } from "zod";

/**
 * Host-access permission state.
 *
 * The only remaining permission-mode axis is whether the assistant can
 * execute commands on the host machine without prompting.
 */
export type PermissionMode = {
  hostAccess: boolean;
};

export const DEFAULT_PERMISSION_MODE: PermissionMode = {
  hostAccess: false,
};

export const PermissionModeSchema = z.object({
  hostAccess: z
    .boolean({ error: "permissionMode.hostAccess must be a boolean" })
    .default(false)
    .describe(
      "Whether the assistant can execute commands on the host machine without prompting",
    ),
});
