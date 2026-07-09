/**
 * Channel-permission matrix cell CRUD + resolve endpoints.
 *
 * HTTP mirror of the IPC surface in `../../ipc/channel-permission-handlers.ts`
 * so configuration clients (web Channels tab) can read and write cells
 * through the gateway SDK. Resolve is exposed read-only so those clients can
 * display the effective fall-through for a coordinate without mirroring the
 * cascade walk client-side (which drifts — e.g. the runtime resolves Slack
 * rooms with no conversation type, so a client-side walk that matched
 * `channel_type` cells would show defaults the evaluator never applies).
 * The runtime evaluator keeps using the IPC resolve; this HTTP surface is
 * for configuration reads only.
 *
 * Mirrors the channel-admission-policy routes — same zod / Response.json /
 * error conventions. No cache invalidation is needed: the runtime evaluator
 * reads cells through the gateway IPC with its own per-turn refresh, and the
 * gateway holds no in-memory cell cache.
 */

import {
  ChannelPermissionCellKeySchema,
  ChannelPermissionCellSchema,
  ResolveChannelPermissionRequestSchema,
  type ChannelPermissionSelector,
} from "@vellumai/gateway-client";

import { ChannelPermissionStore } from "../../db/channel-permission-store.js";
import { CHANNEL_IDS, isChannelId } from "../../channels/types.js";
import { getLogger } from "../../logger.js";

const log = getLogger("channel-permission-overrides");

/**
 * Selectors carry the adapter as free text in the shared contract (the
 * contract package cannot depend on the gateway channel registry); the
 * write paths validate it here so only known adapters are persisted. Same
 * rule as the IPC surface's `assertKnownAdapter`, expressed as a Response.
 */
function unknownAdapterResponse(
  selector: ChannelPermissionSelector,
): Response | null {
  if (selector.scope === "workspace") {
    return null;
  }
  if (isChannelId(selector.adapter)) {
    return null;
  }
  return Response.json(
    {
      error: `Unknown channel adapter: "${selector.adapter}". Must be one of: ${CHANNEL_IDS.join(", ")}`,
    },
    { status: 400 },
  );
}

async function readJsonBody(req: Request): Promise<unknown | Response> {
  try {
    return await req.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /v1/channel-permission-overrides — list persisted cells
// ---------------------------------------------------------------------------

export function createChannelPermissionOverridesListHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const store = new ChannelPermissionStore();
      return Response.json({ cells: store.list() });
    } catch (err) {
      log.error({ err }, "Failed to list channel permission overrides");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/channel-permission-overrides — upsert one cell
// ---------------------------------------------------------------------------

export function createChannelPermissionOverrideSetHandler() {
  return async (req: Request): Promise<Response> => {
    const body = await readJsonBody(req);
    if (body instanceof Response) {
      return body;
    }

    const parsed = ChannelPermissionCellSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error:
            "Invalid request body: expected a cell (selector, contactType, threshold, note?)",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const rejected = unknownAdapterResponse(parsed.data.selector);
    if (rejected) {
      return rejected;
    }

    try {
      const store = new ChannelPermissionStore();
      return Response.json({ cell: store.set(parsed.data) });
    } catch (err) {
      log.error({ err }, "Failed to set channel permission override");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/channel-permission-overrides/resolve — resolve the cascade
// ---------------------------------------------------------------------------

export function createChannelPermissionResolveHandler() {
  return async (req: Request): Promise<Response> => {
    const body = await readJsonBody(req);
    if (body instanceof Response) {
      return body;
    }

    const parsed = ResolveChannelPermissionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error:
            "Invalid request body: expected a resolve query (adapter, channelType?, channelExternalId?, contactType)",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    if (!isChannelId(parsed.data.adapter)) {
      return Response.json(
        {
          error: `Unknown channel adapter: "${parsed.data.adapter}". Must be one of: ${CHANNEL_IDS.join(", ")}`,
        },
        { status: 400 },
      );
    }

    try {
      const store = new ChannelPermissionStore();
      return Response.json({ resolved: store.resolve(parsed.data) });
    } catch (err) {
      log.error({ err }, "Failed to resolve channel permission threshold");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/channel-permission-overrides/delete — remove one cell
// ---------------------------------------------------------------------------

export function createChannelPermissionOverrideDeleteHandler() {
  return async (req: Request): Promise<Response> => {
    const body = await readJsonBody(req);
    if (body instanceof Response) {
      return body;
    }

    const parsed = ChannelPermissionCellKeySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error:
            "Invalid request body: expected a cell key (selector, contactType)",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const rejected = unknownAdapterResponse(parsed.data.selector);
    if (rejected) {
      return rejected;
    }

    try {
      const store = new ChannelPermissionStore();
      return Response.json({
        removed: store.remove(parsed.data.selector, parsed.data.contactType),
      });
    } catch (err) {
      log.error({ err }, "Failed to delete channel permission override");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
