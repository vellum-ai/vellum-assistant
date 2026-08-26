/**
 * IPC-only contact risk-ceiling write. CLI-facing; no HTTP surface.
 *
 * The ceiling itself is gateway-owned. This method relays the write,
 * drops the in-process contact-threshold cache, and notifies connected
 * clients so the next approval and the next contacts read see the new
 * value.
 */

import { z } from "zod";

import { notifyContactsChanged } from "../../contacts/notify-contacts-changed.js";
import { invalidateContactThresholdCache } from "../../permissions/gateway-threshold-reader.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
} from "../../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import { ipcCall } from "../gateway-client.js";

export const SET_CONTACT_THRESHOLD_IPC_METHOD = "set_contact_threshold";

const SetContactThresholdBodySchema = z.object({
  contactId: z.string().min(1),
  threshold: z.enum(["none", "low", "medium", "high"]).nullable(),
});

type GatewaySetContactThresholdResult =
  | { ok: true; contactId: string; threshold: "none" | "low" | "medium" | "high" | null }
  | { ok: false; error: string };

function isGatewaySetResult(
  value: unknown,
): value is GatewaySetContactThresholdResult {
  if (value == null || typeof value !== "object") {
    return false;
  }
  return "ok" in value;
}

/**
 * Persist a contact's assistant-access ceiling on the gateway.
 */
export async function handleSetContactThreshold({
  body = {},
}: RouteHandlerArgs) {
  const parsed = SetContactThresholdBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      "threshold must be one of: none, low, medium, high, or null",
    );
  }

  const result = await ipcCall("set_contact_threshold", {
    contactId: parsed.data.contactId,
    threshold: parsed.data.threshold,
  });

  if (result === undefined || !isGatewaySetResult(result)) {
    throw new InternalError("Failed to persist contact risk ceiling");
  }
  if (result.ok === false) {
    throw new NotFoundError(`Contact "${parsed.data.contactId}" not found`);
  }

  invalidateContactThresholdCache(parsed.data.contactId);
  notifyContactsChanged();
  return result;
}

/**
 * IPC-only contact-threshold methods, keyed by operationId. Registered
 * directly on the assistant IPC server (see `assistant-server.ts`).
 */
export const CONTACT_THRESHOLD_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  [SET_CONTACT_THRESHOLD_IPC_METHOD]: handleSetContactThreshold,
};
