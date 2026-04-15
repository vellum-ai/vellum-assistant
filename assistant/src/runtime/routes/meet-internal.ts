/**
 * HTTP route handler for meet-bot → daemon event ingress.
 *
 * Serves `POST /v1/internal/meet/:meetingId/events`.
 *
 * The request body is a batched JSON array of {@link MeetBotEvent} values.
 * Every event is validated with the Zod discriminated union schema from
 * `@vellumai/meet-contracts`; one invalid entry fails the entire batch
 * with 400 (mirrors how `meet-contracts` models the wire protocol as a
 * union — partial acceptance would leak an inconsistent event stream to
 * downstream subscribers).
 *
 * Auth: `Authorization: Bearer <token>`, where `<token>` matches
 * {@link MeetSessionEventRouter.resolveBotApiToken} for the path's
 * `meetingId`. If the resolver returns `null` (no active session for this
 * id) or the token does not match, the route returns 401.
 *
 * ── Why this is NOT a "new daemon HTTP port consumer" ──
 *
 * CLAUDE.md's "No New Daemon HTTP Port Consumers" rule forbids adding new
 * callers of the daemon's internal HTTP port from CLI commands or other
 * out-of-process code that could use the in-process service/store layer
 * directly.
 *
 * The meet-bot is neither of those. It is a subprocess spawned *by the
 * assistant daemon itself* to join a conference call, and it runs in its
 * own Docker container (or on the same host in local mode). It is, by
 * construction, out-of-process — there is no in-process alternative to
 * route its events through. Its lifecycle is bounded by the daemon that
 * launched it, and it only talks to localhost (or the sibling container
 * over a private bridge).
 *
 * Treat this as an "assistant-spawned subprocess ingress" endpoint — the
 * same category as Twilio's voice webhook bridge or the STT streaming
 * relay, not the category the rule is guarding against (external CLI
 * tools or sibling services calling the daemon HTTP API).
 */

import { timingSafeEqual } from "node:crypto";

import { MeetBotEventSchema } from "@vellumai/meet-contracts";
import { z } from "zod";

import {
  getMeetSessionEventRouter,
  type MeetSessionEventRouter,
} from "../../meet/session-event-router.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";

const log = getLogger("meet-internal-routes");

/**
 * Batched-event request body. The bot buffers events briefly and ships
 * them in small arrays to amortize TLS / HTTP overhead.
 */
export const MeetIngressBatchSchema = z.array(MeetBotEventSchema);
export type MeetIngressBatch = z.infer<typeof MeetIngressBatchSchema>;

/**
 * Handle `POST /v1/internal/meet/:meetingId/events`.
 *
 * Responsibilities:
 *   1. Decode body as `MeetBotEvent[]`. Return 400 on invalid JSON or any
 *      schema violation in the batch.
 *   2. Authenticate the bearer token against the resolver using a
 *      constant-time comparison. 401 on any mismatch.
 *   3. Dispatch each validated event to the registered session handler.
 *   4. Return 204 on success.
 */
export async function handleMeetInternalEvents(
  req: Request,
  meetingId: string,
  router: MeetSessionEventRouter = getMeetSessionEventRouter(),
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  // ── Auth ─────────────────────────────────────────────────────────────
  const expectedToken = router.resolveBotApiToken(meetingId);
  if (!expectedToken) {
    log.warn(
      { meetingId },
      "meet-internal: no active session for meetingId; rejecting",
    );
    return httpError("UNAUTHORIZED", "unauthorized", 401);
  }

  const presented = parseBearerToken(req.headers.get("authorization"));
  if (!presented || !tokensMatch(presented, expectedToken)) {
    log.warn(
      { meetingId, tokenPresented: presented !== null },
      "meet-internal: bearer token mismatch; rejecting",
    );
    return httpError("UNAUTHORIZED", "unauthorized", 401);
  }

  // ── Body parse ───────────────────────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return httpError("BAD_REQUEST", "invalid JSON body", 400);
  }

  const parsed = MeetIngressBatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    log.warn(
      { meetingId, issues: parsed.error.issues },
      "meet-internal: invalid event batch",
    );
    return httpError(
      "BAD_REQUEST",
      "invalid event batch",
      400,
      parsed.error.issues,
    );
  }

  // ── Cross-field validation ───────────────────────────────────────────
  // Defensive: the bot could post a batch tagged for a different
  // meetingId than the path segment. Pre-scan the whole batch and
  // reject atomically — matches the schema-validation behavior so
  // downstream subscribers never see a partial stream from a mixed
  // batch. The bot's session is pinned to exactly one meeting, so any
  // mismatch is a protocol violation.
  for (const event of parsed.data) {
    if (event.meetingId !== meetingId) {
      log.warn(
        {
          pathMeetingId: meetingId,
          eventMeetingId: event.meetingId,
          eventType: event.type,
        },
        "meet-internal: event meetingId does not match path",
      );
      return httpError(
        "BAD_REQUEST",
        "event meetingId does not match path",
        400,
      );
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────────
  for (const event of parsed.data) {
    router.dispatch(meetingId, event);
  }

  return new Response(null, { status: 204 });
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 * Returns `null` when the header is missing, malformed, or uses a
 * non-Bearer scheme. The scheme match is case-insensitive to match
 * RFC 7235.
 */
function parseBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^\s*Bearer\s+(\S+)\s*$/i);
  if (!match) return null;
  return match[1];
}

/**
 * Constant-time token comparison. `timingSafeEqual` requires equal-length
 * inputs, so we bail to `false` on a length mismatch. That length check
 * itself leaks one bit (the expected length) but the expected value is
 * server-minted and not attacker-chosen, so the leak is bounded and
 * acceptable. This matches how `token-service.ts` compares credentials.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Regex used by the http-server router to match the ingress path and
 * extract `meetingId`. Exported so the server-side matcher and tests stay
 * in sync with a single definition. Matches (URL-encoded) `meetingId`
 * values that contain no `/`.
 */
export const MEET_INTERNAL_EVENTS_PATH_RE =
  /^\/v1\/internal\/meet\/([^/]+)\/events$/;
