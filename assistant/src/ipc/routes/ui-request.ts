/**
 * IPC route for interactive UI requests.
 *
 * Exposes `ui_request` so CLI commands and external processes can present
 * interactive UI surfaces to the user and synchronously await their
 * response. The handler delegates to {@link requestInteractiveUi} which
 * manages the full surface lifecycle via the daemon-registered resolver.
 */

import { z } from "zod";

import {
  requestInteractiveUi,
  RESERVED_ACTION_IDS,
} from "../../runtime/interactive-ui.js";
import type { IpcRoute } from "../cli-server.js";

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

// ── Route definition ──────────────────────────────────────────────────

export const uiRequestRoute: IpcRoute = {
  method: "ui_request",
  handler: async (params) => {
    const validated = UiRequestParams.parse(params);
    return requestInteractiveUi(validated);
  },
};
