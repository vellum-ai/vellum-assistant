import { z } from "zod";

import { getConversation } from "../../memory/conversation-crud.js";
import {
  cancelSchedule,
  createSchedule,
  getSchedule,
  listSchedules,
} from "../../schedule/schedule-store.js";
import type { IpcRoute } from "../assistant-server.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DEFERS_PER_CONVERSATION = 50;
const MAX_DEFERS_GLOBAL = 500;
const MAX_DEFER_HORIZON_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countActiveDefers(conversationId?: string): number {
  const jobs = listSchedules({
    mode: "wake",
    createdBy: "defer",
    conversationId,
  });
  return jobs.filter((j) => j.status === "active" || j.status === "firing")
    .length;
}

// ---------------------------------------------------------------------------
// defer_create
// ---------------------------------------------------------------------------

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

const deferCreateRoute: IpcRoute = {
  method: "defer_create",
  handler: async (params) => {
    const { conversationId, hint, delaySeconds, fireAt, name } =
      DeferCreateParams.parse(params);

    const conversation = getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const resolvedFireAt = fireAt ?? Date.now() + delaySeconds! * 1000;

    if (resolvedFireAt < Date.now()) {
      throw new Error("fireAt must be in the future");
    }
    if (resolvedFireAt > Date.now() + MAX_DEFER_HORIZON_MS) {
      throw new Error("fireAt must be within 30 days");
    }

    const perConvo = countActiveDefers(conversationId);
    if (perConvo >= MAX_DEFERS_PER_CONVERSATION) {
      throw new Error(
        `Too many active defers for conversation ${conversationId} (limit: ${MAX_DEFERS_PER_CONVERSATION})`,
      );
    }

    const global = countActiveDefers();
    if (global >= MAX_DEFERS_GLOBAL) {
      throw new Error(
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
  },
};

// ---------------------------------------------------------------------------
// defer_list
// ---------------------------------------------------------------------------

const DeferListParams = z.object({
  conversationId: z.string().optional(),
});

const deferListRoute: IpcRoute = {
  method: "defer_list",
  handler: async (params) => {
    const { conversationId } = DeferListParams.parse(params ?? {});

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
  },
};

// ---------------------------------------------------------------------------
// defer_cancel
// ---------------------------------------------------------------------------

const DeferCancelParams = z
  .object({
    id: z.string().optional(),
    all: z.boolean().optional(),
    conversationId: z.string().optional(),
  })
  .refine((p) => !p.all || p.conversationId, {
    message: "conversationId is required when cancelling all defers",
  });

const deferCancelRoute: IpcRoute = {
  method: "defer_cancel",
  handler: async (params) => {
    const { id, all, conversationId } = DeferCancelParams.parse(params);

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

    throw new Error("Either 'id' or 'all' must be provided to defer_cancel");
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const deferRoutes: IpcRoute[] = [
  deferCreateRoute,
  deferListRoute,
  deferCancelRoute,
];
