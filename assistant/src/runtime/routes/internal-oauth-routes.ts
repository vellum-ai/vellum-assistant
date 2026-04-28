/**
 * Internal OAuth callback route — receives forwarded OAuth results from the
 * gateway and resolves the corresponding pending callback promise in the
 * assistant runtime.
 */

import { z } from "zod";

import {
  consumeCallback,
  consumeCallbackError,
} from "../../security/oauth-callback-registry.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "internal_oauth_callback",
    endpoint: "internal/oauth/callback",
    method: "POST",
    summary: "Internal OAuth callback",
    description:
      "Receives forwarded OAuth callback results (code or error) from the gateway and resolves the pending callback in the runtime.",
    tags: ["internal"],
    requestBody: z.object({
      state: z.string(),
      code: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: ({ body }) => {
      const { state, code, error } = body as {
        state: string;
        code?: string;
        error?: string;
      };

      if (!state) {
        throw new BadRequestError("Missing state parameter");
      }

      if (error) {
        const consumed = consumeCallbackError(state, error);
        if (!consumed) throw new NotFoundError("Unknown state");
        return { ok: true };
      }

      if (code) {
        const consumed = consumeCallback(state, code);
        if (!consumed) throw new NotFoundError("Unknown state");
        return { ok: true };
      }

      throw new BadRequestError("Missing code or error parameter");
    },
  },
];
