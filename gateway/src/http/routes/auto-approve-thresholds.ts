/**
 * Auto-approve threshold CRUD endpoints for the gateway.
 *
 * Global thresholds: GET/PUT on the singleton `autoApproveThresholds` row.
 * Per-conversation overrides: GET/PUT/DELETE on `conversationThresholdOverrides`.
 */

import { eq, sql } from "drizzle-orm";

import { getGatewayDb } from "../../db/connection.js";
import {
  autoApproveThresholds,
  conversationThresholdOverrides,
} from "../../db/schema.js";
import { getLogger } from "../../logger.js";

const log = getLogger("auto-approve-thresholds");

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

export const VALID_THRESHOLDS = ["none", "low", "medium", "high"] as const;
type Threshold = (typeof VALID_THRESHOLDS)[number];

function isValidThreshold(value: unknown): value is Threshold {
  return (
    typeof value === "string" && VALID_THRESHOLDS.includes(value as Threshold)
  );
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/thresholds — global thresholds
// ---------------------------------------------------------------------------

export function createGlobalThresholdGetHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const db = getGatewayDb();
      const row = db
        .select()
        .from(autoApproveThresholds)
        .where(eq(autoApproveThresholds.id, 1))
        .get();

      if (!row) {
        // Return defaults when no row exists yet
        return Response.json({
          interactive: "medium",
          autonomous: "low",
          headless: "none",
        });
      }

      return Response.json({
        interactive: row.interactive,
        autonomous: row.autonomous,
        headless: row.headless,
      });
    } catch (err) {
      log.error({ err }, "Failed to read global thresholds");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/permissions/thresholds — upsert global thresholds
// ---------------------------------------------------------------------------

export function createGlobalThresholdPutHandler() {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const { interactive, autonomous, headless } = body as Record<
      string,
      unknown
    >;

    if (interactive !== undefined && !isValidThreshold(interactive)) {
      return Response.json(
        {
          error: `"interactive" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (autonomous !== undefined && !isValidThreshold(autonomous)) {
      return Response.json(
        {
          error: `"autonomous" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (headless !== undefined && !isValidThreshold(headless)) {
      return Response.json(
        {
          error: `"headless" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }

    try {
      const db = getGatewayDb();
      const row = db
        .insert(autoApproveThresholds)
        .values({
          id: 1,
          ...(interactive ? { interactive } : {}),
          ...(autonomous ? { autonomous } : {}),
          ...(headless ? { headless } : {}),
        })
        .onConflictDoUpdate({
          target: autoApproveThresholds.id,
          set: {
            ...(interactive ? { interactive } : {}),
            ...(autonomous ? { autonomous } : {}),
            ...(headless ? { headless } : {}),
            updatedAt: sql`datetime('now')`,
          },
        })
        .returning()
        .get();

      return Response.json({
        interactive: row.interactive,
        autonomous: row.autonomous,
        headless: row.headless,
      });
    } catch (err) {
      log.error({ err }, "Failed to upsert global thresholds");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/thresholds/conversations/:conversationId
// ---------------------------------------------------------------------------

export function createConversationThresholdGetHandler() {
  return async (_req: Request, params: string[]): Promise<Response> => {
    const conversationId = params[0];
    if (!conversationId) {
      return Response.json(
        { error: "conversationId is required" },
        { status: 400 },
      );
    }

    try {
      const db = getGatewayDb();
      const row = db
        .select()
        .from(conversationThresholdOverrides)
        .where(
          eq(conversationThresholdOverrides.conversationId, conversationId),
        )
        .get();

      if (!row) {
        return Response.json(
          { error: "No override for this conversation" },
          { status: 404 },
        );
      }

      return Response.json({ threshold: row.threshold });
    } catch (err) {
      log.error(
        { err, conversationId },
        "Failed to read conversation threshold override",
      );
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/permissions/thresholds/conversations/:conversationId
// ---------------------------------------------------------------------------

export function createConversationThresholdPutHandler() {
  return async (req: Request, params: string[]): Promise<Response> => {
    const conversationId = params[0];
    if (!conversationId) {
      return Response.json(
        { error: "conversationId is required" },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const { threshold } = body as Record<string, unknown>;

    if (!isValidThreshold(threshold)) {
      return Response.json(
        {
          error: `"threshold" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }

    try {
      const db = getGatewayDb();
      db.insert(conversationThresholdOverrides)
        .values({
          conversationId,
          threshold,
        })
        .onConflictDoUpdate({
          target: conversationThresholdOverrides.conversationId,
          set: {
            threshold,
            updatedAt: sql`datetime('now')`,
          },
        })
        .run();

      return Response.json({ conversationId, threshold });
    } catch (err) {
      log.error(
        { err, conversationId },
        "Failed to upsert conversation threshold override",
      );
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// DELETE /v1/permissions/thresholds/conversations/:conversationId
// ---------------------------------------------------------------------------

export function createConversationThresholdDeleteHandler() {
  return async (_req: Request, params: string[]): Promise<Response> => {
    const conversationId = params[0];
    if (!conversationId) {
      return Response.json(
        { error: "conversationId is required" },
        { status: 400 },
      );
    }

    try {
      const db = getGatewayDb();
      db.delete(conversationThresholdOverrides)
        .where(
          eq(conversationThresholdOverrides.conversationId, conversationId),
        )
        .run();

      // 204 No Content — idempotent, succeeds even if row didn't exist
      return new Response(null, { status: 204 });
    } catch (err) {
      log.error(
        { err, conversationId },
        "Failed to delete conversation threshold override",
      );
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
