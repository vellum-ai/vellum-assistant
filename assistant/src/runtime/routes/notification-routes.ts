/**
 * Route handlers for notification delivery acknowledgments.
 *
 * Provides a REST endpoint for clients to report the outcome of
 * local notification delivery (UNUserNotificationCenter.add).
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../memory/db-connection.js";
import { notificationDeliveries } from "../../memory/schema.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function handleNotificationIntentResult({ body = {} }: RouteHandlerArgs) {
  const { deliveryId, success, errorMessage, errorCode } = body as {
    deliveryId?: string;
    success?: boolean;
    errorMessage?: string;
    errorCode?: string;
  };

  if (!deliveryId || typeof deliveryId !== "string") {
    throw new BadRequestError("deliveryId is required");
  }

  const db = getDb();
  const now = Date.now();

  const updates: Record<string, unknown> = {
    clientDeliveryStatus: success ? "delivered" : "client_failed",
    clientDeliveryAt: now,
    updatedAt: now,
  };
  if (errorMessage) {
    updates.clientDeliveryError = errorMessage;
  }
  if (errorCode) {
    updates.errorCode = errorCode;
  }

  db.update(notificationDeliveries)
    .set(updates)
    .where(eq(notificationDeliveries.id, deliveryId))
    .run();

  return { ok: true };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "notificationintentresult_post",
    endpoint: "notification-intent-result",
    method: "POST",
    summary: "Report notification delivery result",
    description:
      "Client acknowledgment for local notification delivery outcome.",
    tags: ["notifications"],
    requirePolicyEnforcement: true,
    handler: handleNotificationIntentResult,
    requestBody: z.object({
      deliveryId: z.string().describe("Notification delivery ID"),
      success: z.boolean().describe("Whether delivery succeeded").optional(),
      errorMessage: z
        .string()
        .describe("Error message if delivery failed")
        .optional(),
      errorCode: z
        .string()
        .describe("Error code if delivery failed")
        .optional(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
    }),
  },
];
