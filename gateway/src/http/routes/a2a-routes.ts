/**
 * A2A v1.0 gateway routes:
 * - GET  /.well-known/agent-card.json — agent card discovery
 * - POST /a2a/message:send            — inbound message from a peer
 * - POST /a2a/push                    — push notification from a peer
 */

import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import {
  assistantDbQuery,
  assistantDbRun,
} from "../../db/assistant-db-proxy.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { CircuitBreakerOpenError } from "../../runtime/client.js";
import {
  normalizeA2AToInbound,
  normalizeA2APushToInbound,
  type A2AMessage,
  type A2APart,
  type A2ATask,
  type A2ATaskStatus,
  type A2AArtifact,
} from "../../handlers/normalize-a2a.js";
import { getLogger } from "../../logger.js";

const log = getLogger("a2a-routes");

// ── A2A protocol constants (duplicated to avoid cross-package import) ──

const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";

// ── Agent card builder ──────────────────────────────────────────────

interface AgentCard {
  name: string;
  description: string;
  version: string;
  supported_interfaces: Array<{
    url: string;
    protocol_binding: string;
    protocol_version: string;
  }>;
  capabilities: {
    streaming: boolean;
    push_notifications: boolean;
    extended_agent_card: boolean;
  };
  default_input_modes: string[];
  default_output_modes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
}

function buildAgentCard(baseUrl: string, assistantName: string): AgentCard {
  return {
    name: assistantName,
    description: `${assistantName} — a Vellum AI assistant`,
    version: "1.0.0",
    supported_interfaces: [
      {
        url: `${baseUrl}/a2a/message:send`,
        protocol_binding: "JSONRPC",
        protocol_version: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
      push_notifications: true,
      extended_agent_card: false,
    },
    default_input_modes: ["text/plain"],
    default_output_modes: ["text/plain"],
    skills: [
      {
        id: "conversation",
        name: "General conversation",
        description: "Send a message and receive a response",
        tags: ["chat"],
      },
    ],
  };
}

// ── Task store helpers (raw SQL via assistant DB proxy) ──────────────

async function createTaskViaDb(params: {
  contextId?: string;
  senderAssistantId: string;
  requestMessage: A2AMessage;
  pushUrl?: string;
}): Promise<{
  id: string;
  context_id?: string;
  status: A2ATaskStatus;
}> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await assistantDbRun(
    `INSERT INTO a2a_tasks (id, context_id, state, request_message_json, push_url, sender_assistant_id, created_at, updated_at)
     VALUES (?, ?, 'submitted', ?, ?, ?, ?, ?)`,
    [
      id,
      params.contextId ?? null,
      JSON.stringify(params.requestMessage),
      params.pushUrl ?? null,
      params.senderAssistantId,
      now,
      now,
    ],
  );

  return {
    id,
    context_id: params.contextId ?? undefined,
    status: {
      state: "submitted",
      timestamp: new Date(now).toISOString(),
    },
  };
}

async function getTaskFromDb(taskId: string): Promise<A2ATask | null> {
  const rows = await assistantDbQuery<{
    id: string;
    context_id: string | null;
    state: string;
    status_message: string | null;
    artifacts_json: string | null;
    updated_at: number;
    sender_assistant_id: string;
  }>(
    "SELECT id, context_id, state, status_message, artifacts_json, updated_at, sender_assistant_id FROM a2a_tasks WHERE id = ? LIMIT 1",
    [taskId],
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    context_id: row.context_id ?? undefined,
    status: {
      state: row.state,
      message: row.status_message
        ? {
            message_id: crypto.randomUUID(),
            role: "agent",
            parts: [{ kind: "text", text: row.status_message }],
          }
        : undefined,
      timestamp: new Date(row.updated_at).toISOString(),
    },
    artifacts: row.artifacts_json
      ? (JSON.parse(row.artifacts_json) as A2AArtifact[])
      : undefined,
    metadata: { senderAssistantId: row.sender_assistant_id },
  };
}

// ── Validation helpers ──────────────────────────────────────────────

function isValidA2AMessage(msg: unknown): msg is A2AMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.message_id !== "string" || !m.message_id) return false;
  if (m.role !== "user" && m.role !== "agent") return false;
  if (!Array.isArray(m.parts)) return false;
  return m.parts.every(isValidPart);
}

function isValidPart(part: unknown): part is A2APart {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  if (p.kind === "text") return typeof p.text === "string";
  if (p.kind === "data") return !!p.data && typeof p.data === "object";
  if (p.kind === "file") return true;
  return false;
}

function isValidTaskForPush(task: unknown): task is A2ATask {
  if (!task || typeof task !== "object") return false;
  const t = task as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id) return false;
  if (!t.status || typeof t.status !== "object") return false;
  const s = t.status as Record<string, unknown>;
  if (typeof s.state !== "string") return false;
  if (typeof s.timestamp !== "string") return false;
  return true;
}

// ── Route handler factories ─────────────────────────────────────────

export function createAgentCardHandler(configFile: ConfigFileCache) {
  return async (_req: Request): Promise<Response> => {
    const enabled = configFile.getBoolean("a2a", "enabled") ?? false;
    if (!enabled) {
      return Response.json(
        { error: "A2A channel is not enabled" },
        { status: 404 },
      );
    }

    const publicBaseUrl =
      configFile.getString("ingress", "publicBaseUrl") ?? "";
    if (!publicBaseUrl) {
      log.warn("Agent card requested but no public base URL configured");
      return Response.json(
        { error: "Public ingress URL not configured" },
        { status: 503 },
      );
    }

    const assistantName = "Vellum Assistant";
    const card = buildAgentCard(publicBaseUrl, assistantName);

    return Response.json(card, {
      headers: { "Content-Type": "application/json" },
    });
  };
}

export function createSendMessageHandler(
  config: GatewayConfig,
  configFile: ConfigFileCache,
) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const enabled = configFile.getBoolean("a2a", "enabled") ?? false;
    if (!enabled) {
      return Response.json(
        { error: "A2A channel is not enabled" },
        { status: 404 },
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const message = body.message;
    if (!isValidA2AMessage(message)) {
      return Response.json(
        { error: "Invalid A2A message: requires message_id, role, and parts" },
        { status: 400 },
      );
    }

    const senderAssistantId =
      req.headers.get("x-sender-assistant-id") ?? "unknown";
    const senderName = req.headers.get("x-sender-name") ?? undefined;

    // Extract push notification config if provided
    const configuration = body.configuration as
      | Record<string, unknown>
      | undefined;
    const pushConfig = configuration?.task_push_notification_config as
      | { url?: string }
      | undefined;
    const pushUrl =
      typeof pushConfig?.url === "string" ? pushConfig.url : undefined;

    // Create task in the assistant DB to track the request lifecycle
    let task: {
      id: string;
      context_id?: string;
      status: A2ATaskStatus;
    };
    try {
      task = await createTaskViaDb({
        contextId: message.context_id,
        senderAssistantId,
        requestMessage: message,
        pushUrl,
      });
    } catch (err) {
      tlog.error({ err }, "Failed to create A2A task");
      return Response.json({ error: "Failed to create task" }, { status: 500 });
    }

    tlog.info(
      { taskId: task.id, senderAssistantId },
      "A2A message:send — task created",
    );

    // Normalize to GatewayInboundEvent and forward through the standard pipeline
    const inboundEvent = normalizeA2AToInbound(
      message,
      task.id,
      senderAssistantId,
      senderName,
    );

    try {
      const result = await handleInbound(config, inboundEvent, {
        traceId,
        sourceMetadata: {
          a2aTaskId: task.id,
          ...(pushUrl ? { a2aPushUrl: pushUrl } : {}),
        },
      });

      if (result.rejected) {
        tlog.warn(
          { taskId: task.id, reason: result.rejectionReason },
          "A2A message:send rejected by routing",
        );
        return Response.json(
          {
            task: {
              id: task.id,
              context_id: task.context_id,
              status: {
                state: "rejected",
                message: {
                  message_id: crypto.randomUUID(),
                  role: "agent" as const,
                  parts: [
                    {
                      kind: "text" as const,
                      text:
                        result.rejectionReason ?? "Message rejected by policy",
                    },
                  ],
                },
                timestamp: new Date().toISOString(),
              },
            },
          },
          { status: 200 },
        );
      }

      // Return the task in submitted state — the runtime will process
      // asynchronously and push the result if a push URL was provided.
      return Response.json(
        {
          task: {
            id: task.id,
            context_id: task.context_id,
            status: task.status,
          },
        },
        { status: 200 },
      );
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        return Response.json(
          { error: "Service temporarily unavailable" },
          {
            status: 503,
            headers: { "Retry-After": String(err.retryAfterSecs) },
          },
        );
      }
      tlog.error({ err, taskId: task.id }, "Failed to forward A2A message");
      return Response.json(
        { error: "Failed to process message" },
        { status: 500 },
      );
    }
  };
}

export function createPushWebhookHandler(
  config: GatewayConfig,
  configFile: ConfigFileCache,
) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const enabled = configFile.getBoolean("a2a", "enabled") ?? false;
    if (!enabled) {
      return Response.json(
        { error: "A2A channel is not enabled" },
        { status: 404 },
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // The push payload can be a task status update or a full task
    const task = body.task ?? body;
    if (!isValidTaskForPush(task)) {
      return Response.json(
        { error: "Invalid push payload: requires task with id and status" },
        { status: 400 },
      );
    }

    tlog.info(
      { taskId: task.id, state: task.status.state },
      "A2A push received",
    );

    // Look up the original task to get the context_id for routing
    let fullTask: A2ATask;
    try {
      const stored = await getTaskFromDb(task.id);
      if (stored) {
        // Merge the push status onto the stored task
        fullTask = {
          ...stored,
          status: task.status as A2ATaskStatus,
          artifacts: (task as A2ATask).artifacts ?? stored.artifacts,
        };
      } else {
        // Unknown task — use what we have from the push payload
        fullTask = task as A2ATask;
      }
    } catch (err) {
      tlog.warn(
        { err, taskId: task.id },
        "Failed to look up stored task, using push payload",
      );
      fullTask = task as A2ATask;
    }

    // Normalize and forward
    const inboundEvent = normalizeA2APushToInbound(fullTask);

    try {
      const result = await handleInbound(config, inboundEvent, {
        traceId,
        sourceMetadata: {
          a2aTaskId: fullTask.id,
          a2aPushState: fullTask.status.state,
        },
      });

      if (result.rejected) {
        tlog.warn(
          { taskId: fullTask.id, reason: result.rejectionReason },
          "A2A push rejected by routing",
        );
      }

      return Response.json({ ok: true }, { status: 200 });
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        return Response.json(
          { error: "Service temporarily unavailable" },
          {
            status: 503,
            headers: { "Retry-After": String(err.retryAfterSecs) },
          },
        );
      }
      tlog.error({ err, taskId: fullTask.id }, "Failed to forward A2A push");
      return Response.json(
        { error: "Failed to process push" },
        { status: 500 },
      );
    }
  };
}

export { A2A_AGENT_CARD_PATH };
