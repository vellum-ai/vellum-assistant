/**
 * Per-channel inbound admission policy CRUD endpoints.
 *
 * Mutations invalidate the in-memory admission policy cache so subsequent
 * `handle-inbound` evaluations see the new value within the same gateway
 * process (no restart). The cache is wired in P2 so the P3 admission gate
 * can read from it with no further infrastructure work.
 *
 * Mirrors the trust-rule routes — same zod / Response.json / error
 * conventions.
 */

import { z } from "zod";
import {
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_POLICY_VALUES,
  AdmissionPolicyStore,
  isExemptChannelType,
  type AdmissionPolicy,
  type AdmissionPolicyRow,
  type ConversationOverrideView,
} from "../../db/admission-policy-store.js";
import { invalidateAdmissionPolicyCache } from "../../risk/admission-policy-cache.js";
import {
  CHANNEL_IDS,
  isChannelId,
  type ChannelId,
} from "../../channels/types.js";
import { getLogger } from "../../logger.js";

const log = getLogger("channel-admission-policy");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SetPolicyBodySchema = z.object({
  policy: z.enum(ADMISSION_POLICY_VALUES as readonly [string, ...string[]]),
  note: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

interface PolicyView {
  channelType: ChannelId;
  policy: AdmissionPolicy;
  note: string | null;
  updatedAt: number | null;
}

function defaultView(channelType: ChannelId): PolicyView {
  return {
    channelType,
    policy: ADMISSION_POLICY_DEFAULT,
    note: null,
    updatedAt: null,
  };
}

function rowToView(row: AdmissionPolicyRow): PolicyView {
  return {
    channelType: row.channelType,
    policy: row.policy,
    note: row.note,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/channel-admission-policy — list all (merged with defaults)
// ---------------------------------------------------------------------------

export function createChannelAdmissionPolicyListHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const store = new AdmissionPolicyStore();
      const rows = store.list();
      const byChannel = new Map<ChannelId, AdmissionPolicyRow>(
        rows.map((r) => [r.channelType, r]),
      );

      const policies: PolicyView[] = CHANNEL_IDS.map((channel) => {
        const row = byChannel.get(channel);
        return row ? rowToView(row) : defaultView(channel);
      });

      return Response.json({ policies });
    } catch (err) {
      log.error({ err }, "Failed to list channel admission policies");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/channel-admission-policy/:channelType — upsert one
// ---------------------------------------------------------------------------

export function createChannelAdmissionPolicySetHandler() {
  return async (req: Request, channelType: string): Promise<Response> => {
    if (!isChannelId(channelType)) {
      return Response.json(
        {
          error: `Unknown channelType: "${channelType}". Must be one of: ${CHANNEL_IDS.join(", ")}`,
        },
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

    const parsed = SetPolicyBodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error: `Invalid request body: "policy" must be one of: ${ADMISSION_POLICY_VALUES.join(", ")}`,
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    try {
      const store = new AdmissionPolicyStore();
      const row = store.set(
        channelType,
        parsed.data.policy as AdmissionPolicy,
        parsed.data.note ?? null,
      );
      invalidateAdmissionPolicyCache();
      return Response.json({ policy: rowToView(row) });
    } catch (err) {
      log.error({ err }, "Failed to set channel admission policy");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// Conversation override schemas
// ---------------------------------------------------------------------------

const SetConversationOverrideBodySchema = z.object({
  floor: z.enum(ADMISSION_POLICY_VALUES as readonly [string, ...string[]]).nullable(),
  channelType: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Response shape — conversation override
// ---------------------------------------------------------------------------

function overrideToView(view: ConversationOverrideView): ConversationOverrideView {
  return view;
}

// ---------------------------------------------------------------------------
// GET /v1/channel-admission-policy/conversations/:conversationId
// ---------------------------------------------------------------------------

export function createConversationAdmissionGetHandler() {
  return async (req: Request, conversationId: string): Promise<Response> => {
    if (!conversationId) {
      return Response.json({ error: "conversationId is required" }, { status: 400 });
    }
    try {
      // Accept an optional ?channelType= hint from the client so the floor
      // can be resolved correctly for row-less conversations even when the
      // DB has no stored channelType yet (Codex P1 fix).
      const url = new URL(req.url);
      const channelTypeHint = url.searchParams.get("channelType") || undefined;
      const store = new AdmissionPolicyStore();
      const view = store.getConversationOverride(conversationId, channelTypeHint);
      return Response.json({ override: overrideToView(view) });
    } catch (err) {
      log.error({ err }, "Failed to get conversation admission override");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/channel-admission-policy/conversations/:conversationId
// ---------------------------------------------------------------------------

export function createConversationAdmissionSetHandler() {
  return async (req: Request, conversationId: string): Promise<Response> => {
    if (!conversationId) {
      return Response.json({ error: "conversationId is required" }, { status: 400 });
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

    const parsed = SetConversationOverrideBodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error: `Invalid request body: "floor" must be one of: ${(ADMISSION_POLICY_VALUES as readonly string[]).join(", ")} or null`,
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const { floor, channelType } = parsed.data;

    // §8.1: reject writes for exempt internal channels.
    if (channelType && isExemptChannelType(channelType)) {
      return Response.json(
        {
          error: `Channel "${channelType}" is internal (vellum/platform/a2a) and is not user-configurable.`,
        },
        { status: 403 },
      );
    }

    try {
      const store = new AdmissionPolicyStore();

      if (floor === null) {
        // null floor = reset to type default
        store.removeConversationOverride(conversationId);
        const view = store.getConversationOverride(conversationId);
        return Response.json({ override: overrideToView(view) });
      }

      const view = store.setConversationOverride(
        conversationId,
        floor as AdmissionPolicy,
        channelType,
      );
      return Response.json({ override: overrideToView(view) });
    } catch (err) {
      log.error({ err }, "Failed to set conversation admission override");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// DELETE /v1/channel-admission-policy/conversations/:conversationId
// ---------------------------------------------------------------------------

export function createConversationAdmissionDeleteHandler() {
  return async (_req: Request, conversationId: string): Promise<Response> => {
    if (!conversationId) {
      return Response.json({ error: "conversationId is required" }, { status: 400 });
    }
    try {
      const store = new AdmissionPolicyStore();
      store.removeConversationOverride(conversationId);
      const view = store.getConversationOverride(conversationId);
      return Response.json({ override: overrideToView(view) });
    } catch (err) {
      log.error({ err }, "Failed to delete conversation admission override");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// DELETE /v1/channel-admission-policy/:channelType — remove persisted row
// ---------------------------------------------------------------------------

export function createChannelAdmissionPolicyDeleteHandler() {
  return async (_req: Request, channelType: string): Promise<Response> => {
    if (!isChannelId(channelType)) {
      return Response.json(
        {
          error: `Unknown channelType: "${channelType}". Must be one of: ${CHANNEL_IDS.join(", ")}`,
        },
        { status: 400 },
      );
    }

    // §8.1: exempt channels cannot be modified.
    if (isExemptChannelType(channelType)) {
      return Response.json(
        {
          error: `Channel "${channelType}" is internal (vellum/platform/a2a) and is not user-configurable.`,
        },
        { status: 403 },
      );
    }

    try {
      const store = new AdmissionPolicyStore();
      store.remove(channelType as ChannelId);
      invalidateAdmissionPolicyCache();
      // Return the post-delete merged view (default policy) so the client
      // can update its UI optimistically without a separate GET.
      return Response.json({
        policy: defaultView(channelType as ChannelId),
      });
    } catch (err) {
      log.error({ err }, "Failed to delete channel admission policy");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
