import { VellumPlatformClient } from "../platform/client.js";
import type { BackgroundWakeIntent } from "./next-wake.js";

export type BackgroundWakeIntentClientResult = {
  status: "published" | "cleared" | "skipped";
  httpStatus?: number;
  reason?: "missing_platform_client" | "missing_platform_assistant_id";
};

export type BackgroundWakeLeaseClientResult = {
  status: "renewed" | "completed" | "skipped";
  httpStatus?: number;
  reason?: "missing_platform_client" | "missing_platform_assistant_id";
};

type BackgroundWakeIntentSnapshot = Pick<
  BackgroundWakeIntent,
  "sourceGeneration" | "computedAt"
> | null;

export async function publishBackgroundWakeIntent(
  intent: BackgroundWakeIntent,
): Promise<BackgroundWakeIntentClientResult> {
  const client = await VellumPlatformClient.create();
  if (!client) return { status: "skipped", reason: "missing_platform_client" };
  if (!client.platformAssistantId) {
    return { status: "skipped", reason: "missing_platform_assistant_id" };
  }

  const response = await client.fetch(intentPath(client.platformAssistantId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reason: intent.reason,
      source_generation: intent.sourceGeneration,
      computed_at: toIsoString(intent.computedAt),
      next_wake_at: toIsoString(intent.nextWakeAt),
      actual_next_due_at: toIsoString(intent.actualNextDueAt),
      source_payload: intent.sourcePayload,
    }),
  });

  await throwIfNotOk(response, "publish background wake intent");
  return { status: "published", httpStatus: response.status };
}

export async function clearBackgroundWakeIntent(
  intentSnapshot: BackgroundWakeIntentSnapshot = null,
): Promise<BackgroundWakeIntentClientResult> {
  const client = await VellumPlatformClient.create();
  if (!client) return { status: "skipped", reason: "missing_platform_client" };
  if (!client.platformAssistantId) {
    return { status: "skipped", reason: "missing_platform_assistant_id" };
  }

  const body: Record<string, unknown> = {};
  if (intentSnapshot) {
    body.source_generation = intentSnapshot.sourceGeneration;
    body.computed_at = toIsoString(intentSnapshot.computedAt);
  }

  const response = await client.fetch(intentPath(client.platformAssistantId), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  await throwIfNotOk(response, "clear background wake intent");
  return { status: "cleared", httpStatus: response.status };
}

export async function renewBackgroundWakeLease(
  leaseId: string,
): Promise<BackgroundWakeLeaseClientResult> {
  const client = await VellumPlatformClient.create();
  if (!client) return { status: "skipped", reason: "missing_platform_client" };
  if (!client.platformAssistantId) {
    return { status: "skipped", reason: "missing_platform_assistant_id" };
  }

  const response = await client.fetch(
    leasePath(client.platformAssistantId, leaseId, "renew"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );

  await throwIfNotOk(response, "renew background wake lease");
  return { status: "renewed", httpStatus: response.status };
}

export async function completeBackgroundWakeLease(args: {
  leaseId: string;
  status: "completed" | "failed" | "expired";
  error?: string;
  nextIntent?: BackgroundWakeIntent | null;
}): Promise<BackgroundWakeLeaseClientResult> {
  const client = await VellumPlatformClient.create();
  if (!client) return { status: "skipped", reason: "missing_platform_client" };
  if (!client.platformAssistantId) {
    return { status: "skipped", reason: "missing_platform_assistant_id" };
  }

  const body: Record<string, unknown> = {
    status: args.status,
  };
  if (args.error) body.error = args.error;
  if ("nextIntent" in args) {
    body.next_intent = args.nextIntent
      ? {
          reason: args.nextIntent.reason,
          source_generation: args.nextIntent.sourceGeneration,
          computed_at: toIsoString(args.nextIntent.computedAt),
          next_wake_at: toIsoString(args.nextIntent.nextWakeAt),
          actual_next_due_at: toIsoString(args.nextIntent.actualNextDueAt),
          source_payload: args.nextIntent.sourcePayload,
        }
      : null;
  }

  const response = await client.fetch(
    leasePath(client.platformAssistantId, args.leaseId, "complete"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  await throwIfNotOk(response, "complete background wake lease");
  return { status: "completed", httpStatus: response.status };
}

function intentPath(assistantId: string): string {
  const encodedAssistantId = encodeURIComponent(assistantId);
  return `/v1/assistants/${encodedAssistantId}/background-wake-intent/`;
}

function leasePath(
  assistantId: string,
  leaseId: string,
  action: "renew" | "complete",
): string {
  const encodedAssistantId = encodeURIComponent(assistantId);
  const encodedLeaseId = encodeURIComponent(leaseId);
  return `/v1/assistants/${encodedAssistantId}/background-wake-leases/${encodedLeaseId}/${action}/`;
}

function toIsoString(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

async function throwIfNotOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;

  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }

  const detail = body ? `: ${body}` : "";
  throw new Error(`Failed to ${action}: HTTP ${response.status}${detail}`);
}
