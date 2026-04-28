/**
 * Skill IPC route: `host.identity.getAssistantName`.
 *
 * Reads the assistant's display name from IDENTITY.md, normalizing the
 * daemon helper's `null` to `undefined` (serialized as `null` over JSON,
 * which clients translate back to `undefined`).
 */

import { getAssistantName } from "../../daemon/identity-helpers.js";
import type { SkillIpcRoute } from "../skill-ipc-types.js";

export const hostIdentityGetAssistantNameRoute: SkillIpcRoute = {
  method: "host.identity.getAssistantName",
  handler: () => {
    return getAssistantName() ?? null;
  },
};

export const identityRoutes: SkillIpcRoute[] = [
  hostIdentityGetAssistantNameRoute,
];
