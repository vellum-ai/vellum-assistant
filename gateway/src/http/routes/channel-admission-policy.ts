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

import {
  isAdmissionPolicyExemptChannel,
  isAdmissionPolicyHiddenChannel,
} from "@vellumai/gateway-client";
import {
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_POLICY_VALUES,
  AdmissionPolicyStore,
  isExemptChannelType,
  type AdmissionPolicy,
  type AdmissionPolicyRow,
} from "../../db/admission-policy-store.js";
import { invalidateAdmissionPolicyCache } from "../../risk/admission-policy-cache.js";
import {
  CHANNEL_IDS,
  isChannelId,
  type ChannelId,
} from "../../channels/types.js";
import { getLogger } from "../../logger.js";
import { SetChannelPolicyRequestSchema } from "./channel-admission-policy-routes.js";

const log = getLogger("channel-admission-policy");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Wire schema shared with the published OpenAPI spec (single source).
const SetPolicyBodySchema = SetChannelPolicyRequestSchema;

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

      // §8.1: exempt channels (`platform`, `a2a`) are not policy-configurable.
      // Omit them from the client-facing list so the UI never surfaces a
      // control that would 403 on PUT anyway.
      //
      // Hidden channels (`vellum`, `whatsapp`) are still enforced at runtime
      // but intentionally not shown in the Channel Trust Floors UI, so omit
      // them too.
      const policies: PolicyView[] = CHANNEL_IDS.filter(
        (channel) =>
          !isAdmissionPolicyExemptChannel(channel) &&
          !isAdmissionPolicyHiddenChannel(channel),
      ).map((channel) => {
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
    // §8.1: internal channels are exempt from admission policy. Check BEFORE
    // the isChannelId gate so that channels like `platform` (which is in the
    // exempt set but NOT in CHANNEL_IDS) return 403 rather than falling
    // through to the 400 unknown-channel response.
    if (isAdmissionPolicyExemptChannel(channelType)) {
      return Response.json(
        {
          error: "internal channels are exempt from admission policy",
          channelType,
        },
        { status: 403 },
      );
    }

    // Hidden channels (`vellum`, `whatsapp`) are managed automatically at their
    // default floor and not user-configurable. Reject writes so a stale row
    // can't strand them outside the (hidden) Channel Trust Floors UI — the
    // startup seed also resets any drift, this just blocks new drift at the door.
    if (isAdmissionPolicyHiddenChannel(channelType)) {
      return Response.json(
        {
          error: `Channel "${channelType}" is managed automatically and not user-configurable.`,
          channelType,
        },
        { status: 403 },
      );
    }

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
          error: `Channel "${channelType}" is internal (platform/a2a) and is not user-configurable.`,
        },
        { status: 403 },
      );
    }

    // Hidden channels (`vellum`, `whatsapp`) are managed automatically — a
    // delete would just drop the row and let the next seed re-pin the default,
    // so reject it rather than imply the user can reset the floor here.
    if (isAdmissionPolicyHiddenChannel(channelType)) {
      return Response.json(
        {
          error: `Channel "${channelType}" is managed automatically and not user-configurable.`,
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
