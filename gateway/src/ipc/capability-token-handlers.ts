/**
 * IPC route definitions for capability token operations.
 *
 * Exposes token verification to the assistant daemon so it can
 * authenticate browser-relay WebSocket handshakes without reading
 * the HMAC secret directly from the filesystem.
 */

import { z } from "zod";

import { verifyHostBrowserCapability } from "../auth/capability-tokens.js";
import type { IpcRoute } from "./server.js";

const VerifyCapabilityTokenParamsSchema = z.object({
  token: z.string(),
});

export const capabilityTokenRoutes: IpcRoute[] = [
  {
    method: "verify_capability_token",
    schema: VerifyCapabilityTokenParamsSchema,
    handler: (params) => {
      const { token } = params as z.infer<
        typeof VerifyCapabilityTokenParamsSchema
      >;
      const claims = verifyHostBrowserCapability(token);
      return claims ?? { valid: false };
    },
  },
];
