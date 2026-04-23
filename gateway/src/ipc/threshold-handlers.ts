/**
 * IPC route definitions for auto-approve threshold reads.
 *
 * Exposes gateway-owned threshold data to the assistant daemon over
 * the IPC socket. Read-only — writes go through the HTTP control plane.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import { getGatewayDb } from "../db/connection.js";
import {
  autoApproveThresholds,
  conversationThresholdOverrides,
} from "../db/schema.js";
import type { IpcRoute } from "./server.js";

const GLOBAL_DEFAULTS = {
  interactive: "low",
  background: "medium",
  headless: "none",
};

const GetConversationThresholdSchema = z.object({
  conversationId: z.string().min(1),
});

export const thresholdRoutes: IpcRoute[] = [
  {
    method: "get_global_thresholds",
    handler: () => {
      const db = getGatewayDb();
      const row = db
        .select()
        .from(autoApproveThresholds)
        .where(eq(autoApproveThresholds.id, 1))
        .get();

      if (!row) return GLOBAL_DEFAULTS;

      return {
        interactive: row.interactive,
        background: row.background,
        headless: row.headless,
      };
    },
  },
  {
    method: "get_conversation_threshold",
    schema: GetConversationThresholdSchema,
    handler: (params?: Record<string, unknown>) => {
      const conversationId = params?.conversationId as string;
      const db = getGatewayDb();
      const row = db
        .select()
        .from(conversationThresholdOverrides)
        .where(
          eq(conversationThresholdOverrides.conversationId, conversationId),
        )
        .get();

      if (!row) return null;
      return { threshold: row.threshold };
    },
  },
];
