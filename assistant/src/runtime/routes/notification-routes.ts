/**
 * Route handlers for notification delivery acknowledgments.
 *
 * Provides a REST endpoint for clients to report the outcome of
 * local notification delivery (UNUserNotificationCenter.add).
 */

import { eq } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { notificationDeliveries } from "../../memory/schema.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

export function notificationRouteDefinitions(): RouteDefinition[] {
  return [
    // POST /v1/notification-intent-result — client ack for notification delivery
    {
      endpoint: "notification-intent-result",
      method: "POST",
      policyKey: "notification-intent-result",
      summary: "Report notification delivery result",
      description:
        "Client acknowledgment for local notification delivery outcome.",
      tags: ["notifications"],
      requestBody: {
        type: "object",
        properties: {
          deliveryId: {
            type: "string",
            description: "Notification delivery ID",
          },
          success: {
            type: "boolean",
            description: "Whether delivery succeeded",
          },
          errorMessage: {
            type: "string",
            description: "Error message if delivery failed",
          },
          errorCode: {
            type: "string",
            description: "Error code if delivery failed",
          },
        },
        required: ["deliveryId"],
      },
      responseBody: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
      },
      handler: async ({ req }) => {
        const body = (await req.json()) as {
          deliveryId?: string;
          success?: boolean;
          errorMessage?: string;
          errorCode?: string;
        };

        if (!body.deliveryId || typeof body.deliveryId !== "string") {
          return httpError("BAD_REQUEST", "deliveryId is required", 400);
        }

        const db = getDb();
        const now = Date.now();

        const updates: Record<string, unknown> = {
          clientDeliveryStatus: body.success ? "delivered" : "client_failed",
          clientDeliveryAt: now,
          updatedAt: now,
        };
        if (body.errorMessage) {
          updates.clientDeliveryError = body.errorMessage;
        }
        if (body.errorCode) {
          updates.errorCode = body.errorCode;
        }

        db.update(notificationDeliveries)
          .set(updates)
          .where(eq(notificationDeliveries.id, body.deliveryId))
          .run();

        return Response.json({ ok: true });
      },
    },
  ];
}
