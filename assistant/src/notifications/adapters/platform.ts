/**
 * Platform push adapter — delivers notifications to iOS/web clients via
 * the platform's APNs dispatch endpoint.
 *
 * POSTs a `notification_intent` payload to
 * `/v1/assistants/{id}/push/dispatch/`. The platform endpoint fans the
 * notification out to all registered device tokens for the bound user and
 * gates on the `ios-remote-push-enabled` LD flag server-side (returning 202
 * with `{ skipped: "flag_off" }` when the flag is OFF — no action needed
 * from the daemon).
 *
 * Guardian-sensitive notifications (approval requests, escalation alerts)
 * are annotated with `targetGuardianPrincipalId` so the platform can
 * scope APNs fan-out to guardian-bound devices, mirroring the macOS adapter.
 */

import { VellumPlatformClient } from "../../platform/client.js";
import { getLogger } from "../../util/logger.js";
import {
  isRetryableNetworkError,
  isRetryableStatus,
  sleep,
} from "../../util/retry.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";
import { isGuardianSensitiveEvent } from "./macos.js";

const log = getLogger("notif-adapter-platform");

// Exponential backoff delays for 5xx/timeout retries: 250ms → 1s → 4s
const RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

interface DispatchBody {
  delivery_id?: string;
  source_event_name: string;
  title: string;
  body: string;
  deep_link_metadata?: Record<string, unknown>;
  context_payload?: Record<string, unknown>;
  target_guardian_principal_id?: string;
}

export class PlatformPushAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = "platform";

  async send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
  ): Promise<DeliveryResult> {
    const client = await VellumPlatformClient.create();
    if (!client) {
      log.warn(
        { sourceEventName: payload.sourceEventName },
        "Platform client unavailable — skipping push dispatch",
      );
      return { success: false, error: "platform client unavailable" };
    }

    if (!client.platformAssistantId) {
      log.warn(
        { sourceEventName: payload.sourceEventName },
        "Platform assistant ID not configured — skipping push dispatch",
      );
      return { success: false, error: "platform assistant ID not configured" };
    }

    const guardianPrincipalId =
      typeof destination.metadata?.guardianPrincipalId === "string"
        ? destination.metadata.guardianPrincipalId
        : undefined;

    const targetGuardianPrincipalId =
      guardianPrincipalId &&
      isGuardianSensitiveEvent(payload.sourceEventName)
        ? guardianPrincipalId
        : undefined;

    const body: DispatchBody = {
      delivery_id: payload.deliveryId,
      source_event_name: payload.sourceEventName,
      title: payload.copy.title,
      body: payload.copy.body,
      deep_link_metadata: payload.deepLinkTarget,
      context_payload: payload.contextPayload,
      target_guardian_principal_id: targetGuardianPrincipalId,
    };

    const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/push/dispatch/`;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let response: Response;
      try {
        response = await client.fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (
          attempt < RETRY_DELAYS_MS.length &&
          isRetryableNetworkError(err)
        ) {
          log.warn(
            {
              attempt,
              sourceEventName: payload.sourceEventName,
              err: err instanceof Error ? err.message : String(err),
            },
            "Network error dispatching push — retrying",
          );
          await sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { attempt, sourceEventName: payload.sourceEventName, err },
          "Failed to dispatch platform push notification",
        );
        return { success: false, error: message };
      }

      if (response.ok) {
        log.info(
          {
            sourceEventName: payload.sourceEventName,
            title: payload.copy.title,
            guardianScoped: targetGuardianPrincipalId != null,
            status: response.status,
          },
          "Platform push dispatched",
        );
        return { success: true };
      }

      if (attempt < RETRY_DELAYS_MS.length && isRetryableStatus(response.status)) {
        log.warn(
          {
            attempt,
            status: response.status,
            sourceEventName: payload.sourceEventName,
          },
          "Retryable status from push dispatch endpoint",
        );
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }

      const errorText = await response.text().catch(() => "");
      log.error(
        {
          status: response.status,
          sourceEventName: payload.sourceEventName,
          body: errorText.slice(0, 256),
        },
        "Non-retryable error from push dispatch endpoint",
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText.slice(0, 128)}`,
      };
    }

    // Unreachable — loop always returns or continues, but TypeScript needs this.
    return { success: false, error: "retry exhausted" };
  }
}
