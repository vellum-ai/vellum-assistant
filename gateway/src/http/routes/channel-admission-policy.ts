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
import { isAdmissionPolicyExemptChannel } from "@vellumai/gateway-client";
import {
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_POLICY_VALUES,
  AdmissionPolicyStore,
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

      // §8.1: internal channels (`vellum`, `platform`, `a2a`) are not
      // policy-configurable. Omit them from the client-facing list so the
      // UI never surfaces a control that would 403 on PUT anyway.
      const policies: PolicyView[] = CHANNEL_IDS.filter(
        (channel) => !isAdmissionPolicyExemptChannel(channel),
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
    if (!isChannelId(channelType)) {
      return Response.json(
        {
          error: `Unknown channelType: "${channelType}". Must be one of: ${CHANNEL_IDS.join(", ")}`,
        },
        { status: 400 },
      );
    }

    // §8.1: internal channels are exempt from admission policy. Reject the
    // PUT with 403 — guardians configuring `no_one` on `vellum` would lock
    // themselves out of their own client. Defense in depth alongside the
    // runtime exempt-channel short-circuit and the gateway kill switch.
    if (isAdmissionPolicyExemptChannel(channelType)) {
      return Response.json(
        {
          error:
            "internal channels are exempt from admission policy",
          channelType,
        },
        { status: 403 },
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
