/**
 * Transport-agnostic routes for deferred conversation wakes.
 *
 * Exposes create/list/cancel operations for scheduling future wake-ups
 * on conversations via the schedule store.
 */

import { z } from "zod";

import { getConversation } from "../../memory/conversation-crud.js";
import {
  cancelSchedule,
  createSchedule,
  getSchedule,
  listSchedules,
} from "../../schedule/schedule-store.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────

const MAX_DEFERS_PER_CONVERSATION = 50;
const MAX_DEFERS_GLOBAL = 500;
const MAX_DEFER_HORIZON_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Helpers ───────────────────────────────────────────────────────────

function countActiveDefers(conversationId?: string): number {
  const jobs = listSchedules({
    mode: "wake",
    createdBy: "defer",
    conversationId,
  });
  return jobs.filter((j) => j.status === "active" || j.status === "firing")
    .length;
}

// ── Schemas ───────────────────────────────────────────────────────────

const DeferCreateParams = z
  .object({
    conversationId: z.string().min(1),
    hint: z.string().min(1),
    delaySeconds: z.number().optional(),
    fireAt: z.number().optional(),
    name: z.string().optional(),
  })
  .refine((p) => p.delaySeconds != null || p.fireAt != null, {
    message: "Either delaySeconds or fireAt must be provided",
  });

const DeferListParams = z.object({
  conversationId: z.string().optional(),
});

const DeferCancelParams = z.object({
  id: z.string().optional(),
  all: z.boolean().optional(),
  conversationId: z.string().optional(),
});

// ── Handlers ──────────────────────────────────────────────────────────

async function handleDeferCreate({ body = {} }: RouteHandlerArgs) {
  const { conversationId, hint, delaySeconds, fireAt, name } =
    DeferCreateParams.parse(body);

  const conversation = getConversation(conversationId);
  if (!conversation) {
    throw new NotFoundError(`Conversation not found: ${conversationId}`);
  }

  const resolvedFireAt = fireAt ?? Date.now() + delaySeconds! * 1000;

  if (resolvedFireAt < Date.now()) {
    throw new BadRequestError("fireAt must be in the future");
  }
  if (resolvedFireAt > Date.now() + MAX_DEFER_HORIZON_MS) {
    throw new BadRequestError("fireAt must be within 30 days");
  }

  const perConvo = countActiveDefers(conversationId);
  if (perConvo >= MAX_DEFERS_PER_CONVERSATION) {
    throw new BadRequestError(
      `Too many active defers for conversation ${conversationId} (limit: ${MAX_DEFERS_PER_CONVERSATION})`,
    );
  }

  const global = countActiveDefers();
  if (global >= MAX_DEFERS_GLOBAL) {
    throw new BadRequestError(
      `Too many active defers globally (limit: ${MAX_DEFERS_GLOBAL})`,
    );
  }

  const job = createSchedule({
    name: name ?? "Deferred wake",
    message: hint,
    mode: "wake",
    wakeConversationId: conversationId,
    nextRunAt: resolvedFireAt,
    quiet: true,
    createdBy: "defer",
  });

  return {
    id: job.id,
    name: job.name,
    fireAt: resolvedFireAt,
    conversationId,
  };
}

async function handleDeferList({ body = {} }: RouteHandlerArgs) {
  const { conversationId } = DeferListParams.parse(body);

  const jobs = listSchedules({
    mode: "wake",
    createdBy: "defer",
    conversationId,
  });

  const active = jobs.filter(
    (j) => j.status === "active" || j.status === "firing",
  );

  return {
    defers: active.map((j) => ({
      id: j.id,
      name: j.name,
      hint: j.message,
      conversationId: j.wakeConversationId,
      fireAt: j.nextRunAt,
      status: j.status,
    })),
  };
}

async function handleDeferCancel({ body = {} }: RouteHandlerArgs) {
  const { id, all, conversationId } = DeferCancelParams.parse(body);

  if (id) {
    const job = getSchedule(id);
    if (!job || job.mode !== "wake" || job.createdBy !== "defer") {
      return { cancelled: 0, error: "Not a deferred wake" };
    }
    const ok = cancelSchedule(id);
    return { cancelled: ok ? 1 : 0 };
  }

  if (all) {
    const jobs = listSchedules({
      mode: "wake",
      createdBy: "defer",
      conversationId,
    });

    let count = 0;
    for (const j of jobs) {
      if (j.status === "active" || j.status === "firing") {
        if (cancelSchedule(j.id)) count++;
      }
    }
    return { cancelled: count };
  }

  throw new BadRequestError(
    "Either 'id' or 'all' must be provided to defer_cancel",
  );
}

// ── Routes ────────────────────────────────────────────────────────────

const DeferResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  hint: z.string(),
  conversationId: z.string(),
  fireAt: z.number(),
  status: z.string(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "defer_create",
    endpoint: "defer/create",
    method: "POST",
    handler: handleDeferCreate,
    summary: "Create a deferred wake",
    description:
      "Schedule a future wake-up on a conversation, optionally with a delay or absolute timestamp.",
    tags: ["defer"],
    requestBody: DeferCreateParams,
    responseBody: z.object({
      id: z.string(),
      name: z.string(),
      fireAt: z.number(),
      conversationId: z.string(),
    }),
  },
  {
    operationId: "defer_list",
    endpoint: "defer/list",
    method: "POST",
    handler: handleDeferList,
    summary: "List active deferred wakes",
    description:
      "List all active deferred wakes, optionally filtered by conversation.",
    tags: ["defer"],
    requestBody: DeferListParams,
    responseBody: z.object({
      defers: z.array(DeferResponseSchema),
    }),
  },
  {
    operationId: "defer_cancel",
    endpoint: "defer/cancel",
    method: "POST",
    handler: handleDeferCancel,
    summary: "Cancel deferred wakes",
    description:
      "Cancel a specific deferred wake by ID, or all defers for a conversation.",
    tags: ["defer"],
    requestBody: DeferCancelParams,
    responseBody: z.object({
      cancelled: z.number(),
      error: z.string().optional(),
    }),
  },
];
