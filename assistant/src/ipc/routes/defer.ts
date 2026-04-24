import { z } from "zod";

import {
  cancelSchedule,
  createSchedule,
  getSchedule,
  listSchedules,
} from "../../schedule/schedule-store.js";
import type { IpcRoute } from "../assistant-server.js";

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

    const resolvedFireAt = fireAt ?? Date.now() + delaySeconds! * 1000;

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

const DeferCancelParams = z.object({
  id: z.string().optional(),
  all: z.boolean().optional(),
  conversationId: z.string().optional(),
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
