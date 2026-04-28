/**
 * Transport-agnostic route for interactive UI requests.
 */

import { z } from "zod";

import {
  requestInteractiveUi,
  RESERVED_ACTION_IDS,
} from "../../runtime/interactive-ui.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Param schema ──────────────────────────────────────────────────────

const UiRequestParams = z.object({
  conversationId: z.string().min(1),
  surfaceType: z.enum(["confirmation", "form"]),
  title: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  actions: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .refine((id) => !RESERVED_ACTION_IDS.has(id), {
            message: `Action id is reserved for internal use. Reserved IDs: ${[...RESERVED_ACTION_IDS].sort().join(", ")}`,
          }),
        label: z.string().min(1),
        variant: z.enum(["primary", "danger", "secondary"]).optional(),
      }),
    )
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
});

// ── Handler ───────────────────────────────────────────────────────────

async function handleUiRequest({ body = {} }: RouteHandlerArgs) {
  const validated = UiRequestParams.parse(body);
  return requestInteractiveUi(validated);
}

// ── Route definition ──────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "ui_request",
    endpoint: "ui/request",
    method: "POST",
    handler: handleUiRequest,
    summary: "Present an interactive UI surface",
    description:
      "Present an interactive UI surface to the user and await their response.",
    tags: ["ui"],
    requestBody: UiRequestParams,
  },
];
