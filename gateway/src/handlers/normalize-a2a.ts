/**
 * A2A message normalization — converts A2A protocol messages and push
 * notification responses into the gateway's standard GatewayInboundEvent
 * shape so they flow through the same inbound pipeline as every other channel.
 *
 * Type definitions for A2A protocol objects are duplicated here from
 * assistant/src/a2a/protocol-types.ts to respect the cross-package import
 * boundary (AGENTS.md: gateway must not import from assistant via relative
 * paths). Only the subset needed for normalization is defined.
 */

import type { A2aInboundEvent } from "../channels/inbound-event.js";

// ── A2A protocol types (subset for normalization) ──────────────────

interface TextPart {
  kind: "text";
  text: string;
}

interface DataPart {
  kind: "data";
  data: Record<string, unknown>;
}

interface FilePart {
  kind: "file";
  url?: string;
  raw?: string;
  filename?: string;
}

export type A2APart = TextPart | DataPart | FilePart;

export interface A2AMessage {
  message_id: string;
  context_id?: string;
  task_id?: string;
  role: "user" | "agent";
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  state: string;
  message?: A2AMessage;
  timestamp: string;
}

export interface A2AArtifact {
  artifact_id: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  context_id?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

// ── Extraction / normalization ─────────────────────────────────────

/**
 * Extract displayable text from A2A message parts.
 *
 * - TextPart: joined as-is
 * - DataPart: JSON-stringified
 * - FilePart: skipped for MVP (file handling deferred)
 */
export function extractTextContent(parts: A2APart[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    switch (part.kind) {
      case "text":
        segments.push(part.text);
        break;
      case "data":
        segments.push(JSON.stringify(part.data));
        break;
      case "file":
        // File parts skipped for MVP
        break;
    }
  }
  return segments.join("\n");
}

/**
 * Normalize an inbound A2A message (from `message:send`) into a
 * GatewayInboundEvent that can be forwarded through the standard pipeline.
 */
export function normalizeA2AToInbound(
  message: A2AMessage,
  taskId: string,
  senderAssistantId: string,
  senderName?: string,
): A2aInboundEvent {
  const content = extractTextContent(message.parts);
  const now = new Date().toISOString();

  return {
    version: "v1",
    sourceChannel: "a2a",
    receivedAt: now,
    message: {
      content,
      conversationExternalId: message.context_id ?? taskId,
      externalMessageId: message.message_id,
    },
    actor: {
      actorExternalId: senderAssistantId,
      displayName: senderName,
    },
    source: {
      updateId: message.message_id,
    },
    raw: { message, taskId },
  };
}

/**
 * Normalize an A2A push notification (completed task from a peer) into a
 * GatewayInboundEvent routed via the task's context_id.
 */
export function normalizeA2APushToInbound(task: A2ATask): A2aInboundEvent {
  const now = new Date().toISOString();

  // Build content from the status message or artifacts
  let content = "";
  if (task.status.message) {
    content = extractTextContent(task.status.message.parts);
  } else if (task.artifacts && task.artifacts.length > 0) {
    const segments: string[] = [];
    for (const artifact of task.artifacts) {
      segments.push(extractTextContent(artifact.parts));
    }
    content = segments.join("\n");
  }

  // The sender is the remote assistant that processed the task.
  // Metadata may carry the sender identity from the original request.
  const senderAssistantId =
    (task.metadata?.senderAssistantId as string) ?? "unknown";

  return {
    version: "v1",
    sourceChannel: "a2a",
    receivedAt: now,
    message: {
      content,
      conversationExternalId: task.context_id ?? task.id,
      externalMessageId: `push-${task.id}-${task.status.timestamp}`,
    },
    actor: {
      actorExternalId: senderAssistantId,
    },
    source: {
      updateId: `push-${task.id}`,
    },
    raw: { task },
  };
}
