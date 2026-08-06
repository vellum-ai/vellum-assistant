/**
 * Platform push adapter for native mobile notification delivery.
 *
 * POSTs a `notification_intent` payload to
 * `/v1/assistants/{id}/push/dispatch/`. The platform endpoint fans the
 * notification out to registered device tokens for the bound user. Provider
 * feature gates return 202 with `{ skipped: "flag_off" }` when no provider runs.
 *
 * Guardian-sensitive notifications (approval requests, access requests)
 * are annotated with `targetGuardianPrincipalId` so the platform can
 * scope native fan-out to guardian-bound devices, mirroring the macOS adapter.
 */

import { VellumPlatformClient } from "../../platform/client.js";
import { getLogger } from "../../util/logger.js";
import {
  isRetryableNetworkError,
  isRetryableStatus,
  sleep,
} from "../../util/retry.js";
import {
  describeMedia,
  mediaEmbeds,
  stripMarkdownForPreview,
} from "../notification-utils.js";
import type {
  ChannelAdapter,
  ChannelDeliveryObserver,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";
import { isGuardianSensitiveEvent } from "./macos.js";

const log = getLogger("notif-adapter-platform");

// Exponential backoff delays for 5xx/timeout retries: 250ms → 1s → 4s
const RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

// Per-attempt abort timeout. The underlying platform fetch has no timeout of
// its own, and the broadcaster defers the urgent local banner on this
// dispatch's outcome -- a hung platform must fail the attempt, not stall it.
const ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Flatten one alert field for a plain-text surface, recovering copy when
 * flattening leaves nothing behind.
 *
 * An APNs/FCM alert renders no markdown, so markers arrive as literal
 * punctuation. Flattening here covers every event routed to this channel
 * without altering what other channels receive, some of which render markdown
 * deliberately. Newlines survive: iOS renders them, and guardian copy carries a
 * deliberate paragraph break.
 *
 * The recovery is load-bearing rather than cosmetic. Copy composed entirely of
 * media embeds, which the pass-through path copies into both the title and the
 * body, flattens to nothing, and the pipeline's empty-copy guards all run
 * upstream of this adapter. The platform's serializer rejects a blank title,
 * so an unrecovered field costs the whole notification, not just its wording.
 */
function flattenAlertField(value: string): string {
  const flattened = stripMarkdownForPreview(value);
  if (flattened.trim().length > 0) {
    return flattened;
  }
  return describeMedia(mediaEmbeds(value).map((embed) => embed.alt)) || value;
}

/** Whether a fetch error is the per-attempt abort timeout firing. */
function isAttemptTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

interface DispatchBody {
  delivery_id?: string;
  source_event_name: string;
  title: string;
  body: string;
  deep_link_metadata?: Record<string, unknown>;
  context_payload?: Record<string, unknown>;
  target_guardian_principal_id?: string;
}

type RemotePushPlatform = "ios" | "android";

function acceptedPlatforms(body: unknown): RemotePushPlatform[] | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const value = (body as { accepted_platforms?: unknown }).accepted_platforms;
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(
    (platform): platform is RemotePushPlatform =>
      platform === "ios" || platform === "android",
  );
}

export class PlatformPushAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = "platform";

  async send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
    observer?: ChannelDeliveryObserver,
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
      guardianPrincipalId && isGuardianSensitiveEvent(payload.sourceEventName)
        ? guardianPrincipalId
        : undefined;

    const body: DispatchBody = {
      delivery_id: payload.correlationId ?? payload.deliveryId,
      source_event_name: payload.sourceEventName,
      title: flattenAlertField(payload.copy.title),
      body: flattenAlertField(payload.copy.body),
      deep_link_metadata: payload.deepLinkTarget,
      context_payload: payload.contextPayload,
      target_guardian_principal_id: targetGuardianPrincipalId,
    };

    const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/push/dispatch/`;
    const accumulatedPlatforms = new Set<RemotePushPlatform>();
    let platformsReported = false;
    const remotePushPlatforms = () =>
      platformsReported ? [...accumulatedPlatforms] : undefined;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let response: Response;
      try {
        response = await client.fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
      } catch (err) {
        if (
          attempt < RETRY_DELAYS_MS.length &&
          (isAttemptTimeout(err) || isRetryableNetworkError(err))
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
        return {
          success: false,
          error: message,
          remotePushPlatforms: remotePushPlatforms(),
        };
      }

      const responseText = await response.text().catch(() => "");
      let responseBody: unknown = null;
      try {
        responseBody = JSON.parse(responseText) as unknown;
      } catch {
        responseBody = null;
      }
      const responsePlatforms = acceptedPlatforms(responseBody);
      if (responsePlatforms) {
        platformsReported = true;
        for (const platform of responsePlatforms) {
          accumulatedPlatforms.add(platform);
        }
        observer?.onRemotePushPlatforms(remotePushPlatforms()!);
      }

      if (response.ok) {
        // A 2xx does not mean a push went out: the server returns
        // 202 {"skipped": ...} when the feature flag is off or no tokens
        // are registered, and 200 with tokens_sent: 0 on idempotent
        // replays. Only report acceptance when the body confirms at least
        // one device push was dispatched; an unparseable or ambiguous body
        // counts as not accepted (a duplicate client banner beats a lost
        // notification).
        const parsedBody = responseBody as {
          accepted_platforms?: unknown;
          skipped?: unknown;
          tokens_sent?: unknown;
        } | null;
        const remotePushAccepted =
          parsedBody != null &&
          !parsedBody.skipped &&
          typeof parsedBody.tokens_sent === "number" &&
          parsedBody.tokens_sent > 0;
        log.info(
          {
            sourceEventName: payload.sourceEventName,
            title: payload.copy.title,
            guardianScoped: targetGuardianPrincipalId != null,
            status: response.status,
            remotePushAccepted,
          },
          "Platform push dispatched",
        );
        return {
          success: true,
          remotePushAccepted,
          remotePushPlatforms: remotePushPlatforms(),
        };
      }

      if (
        attempt < RETRY_DELAYS_MS.length &&
        isRetryableStatus(response.status)
      ) {
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

      log.error(
        {
          status: response.status,
          sourceEventName: payload.sourceEventName,
          body: responseText.slice(0, 256),
        },
        "Non-retryable error from push dispatch endpoint",
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${responseText.slice(0, 128)}`,
        remotePushPlatforms: remotePushPlatforms(),
      };
    }

    // Unreachable — loop always returns or continues, but TypeScript needs this.
    return { success: false, error: "retry exhausted" };
  }
}
