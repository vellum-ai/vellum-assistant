/**
 * IPC-only guardian display-label method called by the gateway over the
 * assistant IPC socket (`ipcCallAssistant`).
 *
 * The gateway's native contact reads serve rows from the gateway DB, but the
 * guardian's display label is derived from assistant-side state (the guardian
 * persona file's preferred name). This method exposes that resolution so the
 * gateway can present the same guardian label the daemon's read relay does.
 *
 * Like the other gateway-facing methods here, it has no HTTP surface: it is
 * registered directly on the IPC server (see `assistant-server.ts`) and never
 * enters the shared `ROUTES` array.
 */

import { z } from "zod";

import { resolveGuardianName } from "../../prompts/user-reference.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

const ResolveGuardianLabelParamsSchema = z.object({
  storedDisplayName: z.string().nullable().optional(),
});

/**
 * Resolve the guardian's display label: the persona-file preferred name when
 * set, else the stored displayName, else the default user reference.
 */
export function handleResolveGuardianLabel({ body = {} }: RouteHandlerArgs) {
  const { storedDisplayName } = ResolveGuardianLabelParamsSchema.parse(body);
  return { label: resolveGuardianName(storedDisplayName ?? null) };
}

/**
 * IPC-only guardian-label methods, keyed by IPC operationId. Registered
 * directly on the assistant IPC server (see `assistant-server.ts`).
 */
export const GUARDIAN_LABEL_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  resolve_guardian_label: handleResolveGuardianLabel,
};
