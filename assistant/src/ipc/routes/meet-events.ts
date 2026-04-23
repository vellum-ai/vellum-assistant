/**
 * IPC route for meet-bot → daemon event ingress.
 *
 * Replaces the HTTP `POST /v1/internal/meet/:meetingId/events` path for
 * bot containers that share the `assistant-cli.sock` Unix socket via a
 * volume mount. This eliminates the bot's dependency on `host.docker.internal`
 * and the daemon's published HTTP port — addressing ATL-162.
 *
 * Wire format (IPC):
 *   method: "meet_events"
 *   params: { meetingId: string, botApiToken: string, events: MeetBotEvent[] }
 *
 * Auth: `botApiToken` is verified against the session registry using
 * timing-safe comparison, same as the HTTP route.
 */

import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { IpcRoute } from "../cli-server.js";
import { MeetBotEventSchema } from "../../../../skills/meet-join/contracts/index.js";
import {
  getMeetSessionEventRouter,
  type MeetSessionEventRouter,
} from "../../../../skills/meet-join/daemon/session-event-router.js";

const BatchSchema = z.array(MeetBotEventSchema);

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const meetEventsRoute: IpcRoute = {
  method: "meet_events",
  handler: async (params) => {
    const meetingId = params?.meetingId;
    const botApiToken = params?.botApiToken;
    const events = params?.events;

    if (typeof meetingId !== "string" || !meetingId) {
      throw new Error("missing or invalid meetingId");
    }
    if (typeof botApiToken !== "string" || !botApiToken) {
      throw new Error("missing or invalid botApiToken");
    }
    if (!Array.isArray(events)) {
      throw new Error("events must be an array");
    }

    const router: MeetSessionEventRouter = getMeetSessionEventRouter();
    const expectedToken = router.resolveBotApiToken(meetingId);
    if (!expectedToken) {
      throw new Error("unauthorized: no active session for meetingId");
    }
    if (!tokensMatch(botApiToken, expectedToken)) {
      throw new Error("unauthorized: token mismatch");
    }

    const parsed = BatchSchema.safeParse(events);
    if (!parsed.success) {
      throw new Error(`invalid event batch: ${parsed.error.message}`);
    }

    for (const event of parsed.data) {
      if (event.meetingId !== meetingId) {
        throw new Error("event meetingId does not match params meetingId");
      }
    }

    for (const event of parsed.data) {
      router.dispatch(meetingId, event);
    }

    return { dispatched: parsed.data.length };
  },
};
