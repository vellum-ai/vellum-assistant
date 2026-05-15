/**
 * A2A direct delivery adapter.
 *
 * Completes an A2A task with response artifacts and optionally POSTs the
 * completed task to the requester's push notification URL.
 */

import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
} from "@vellumai/gateway-client";

import {
  A2A_CONTENT_TYPE,
  A2A_VERSION,
  A2A_VERSION_HEADER,
} from "../../../a2a/protocol-constants.js";
import type { Part } from "../../../a2a/protocol-types.js";
import * as taskStore from "../../../a2a/task-store.js";
import { getLogger } from "../../../util/logger.js";
import {
  computeRetryDelay,
  isRetryableStatus,
  sleep,
} from "../../../util/retry.js";

const log = getLogger("a2a-deliver");

const MAX_RETRIES = 3;
const PUSH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the `taskId` query parameter from a callback URL. */
function parseTaskId(callbackUrl: string): string | null {
  try {
    return new URL(callbackUrl).searchParams.get("taskId");
  } catch {
    return null;
  }
}

/** Build A2A parts from a channel reply payload. */
function buildParts(payload: ChannelReplyPayload): Part[] {
  const parts: Part[] = [];

  if (payload.text) {
    parts.push({ kind: "text", text: payload.text });
  }

  if (payload.attachments) {
    for (const att of payload.attachments) {
      parts.push({
        kind: "file",
        filename: att.filename,
        media_type: att.mimeType,
        url: att.data,
      });
    }
  }

  return parts;
}

/** POST the completed task to the requester's push URL with retry. */
async function pushNotification(
  pushUrl: string,
  taskJson: unknown,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(computeRetryDelay(attempt - 1));
    }

    try {
      const response = await fetch(pushUrl, {
        method: "POST",
        headers: {
          "Content-Type": A2A_CONTENT_TYPE,
          [A2A_VERSION_HEADER]: A2A_VERSION,
        },
        body: JSON.stringify(taskJson),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });

      if (response.ok) return;

      const body = await response.text().catch(() => "");
      lastError = new Error(
        `Push notification failed with status ${response.status}: ${body}`,
      );

      if (!isRetryableStatus(response.status)) {
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  // Push failure is logged but doesn't propagate
  log.warn(
    { pushUrl, error: lastError?.message },
    "A2A push notification failed after retries",
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Deliver an assistant reply as an A2A task completion. */
export async function deliverA2AReply(
  callbackUrl: string,
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  const taskId = parseTaskId(callbackUrl);
  if (!taskId) {
    return { ok: false };
  }

  const parts = buildParts(payload);
  if (parts.length === 0) {
    log.debug({ taskId }, "No content to deliver; skipping A2A completion");
    return { ok: true };
  }

  let completedTask;
  try {
    completedTask = taskStore.completeWithArtifacts(taskId, [
      { artifact_id: crypto.randomUUID(), parts },
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ taskId, error: message }, "Failed to complete A2A task");
    return { ok: false };
  }

  // Push notification — fire-and-forget
  const pushUrl = taskStore.getPushUrl(taskId);
  if (pushUrl) {
    pushNotification(pushUrl, completedTask).catch((err) => {
      log.error(
        { taskId, pushUrl, error: String(err) },
        "Unexpected push notification error",
      );
    });
  }

  log.info({ taskId }, "A2A reply delivered");
  return { ok: true };
}
