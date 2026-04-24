/**
 * Skill IPC routes: `host.identity.getAssistantName` and
 * `host.identity.getInternalAssistantId`.
 *
 * Match the `IdentityFacet` surface exposed by `DaemonSkillHost`:
 * - `getAssistantName` reads the assistant's display name from IDENTITY.md,
 *   normalizing the daemon helper's `null` to `undefined` (serialized as
 *   `null` over JSON, which clients translate back to `undefined`).
 * - `getInternalAssistantId` returns the `DAEMON_INTERNAL_ASSISTANT_ID`
 *   constant (`"self"`) so skill-side code uses the same internal scope.
 */

import { getAssistantName } from "../../daemon/identity-helpers.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import type { IpcRoute } from "../assistant-server.js";

export const hostIdentityGetAssistantNameRoute: IpcRoute = {
  method: "host.identity.getAssistantName",
  handler: () => {
    return getAssistantName() ?? null;
  },
};

export const hostIdentityGetInternalAssistantIdRoute: IpcRoute = {
  method: "host.identity.getInternalAssistantId",
  handler: () => {
    return DAEMON_INTERNAL_ASSISTANT_ID;
  },
};

export const identityRoutes: IpcRoute[] = [
  hostIdentityGetAssistantNameRoute,
  hostIdentityGetInternalAssistantIdRoute,
];
