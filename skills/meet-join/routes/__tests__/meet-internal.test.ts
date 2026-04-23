/**
 * Unit tests for the `/v1/internal/meet/:meetingId/events` ingress handler.
 *
 * The handler function is invoked directly against a real
 * `MeetSessionEventRouter` wired with a synchronous test token resolver.
 * This matches the style of other inline-dispatched pre-auth routes
 * (e.g. `handleBrowserExtensionPair`) — simpler and faster than standing
 * up the full HTTP server.
 */

import { describe, expect, test } from "bun:test";

import type { SkillHost } from "@vellumai/skill-host-contracts";

import type { MeetBotEvent } from "../../contracts/index.js";

import { MeetSessionEventRouter } from "../../daemon/session-event-router.js";
import { handleMeetInternalEvents } from "../meet-internal.js";

/**
 * Minimal host stub covering just the surface `handleMeetInternalEvents`
 * touches today — logger access. Extended to a full `SkillHost` via a
 * throwing proxy so any unexpected facet access fails loudly rather than
 * silently returning `undefined`.
 */
function buildTestHost(): SkillHost {
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const throwing = (name: string): never => {
    throw new Error(`unexpected host.${name} access in meet-internal test`);
  };
  return new Proxy({} as SkillHost, {
    get: (_t, prop) => {
      if (prop === "logger") return { get: () => noopLogger };
      return throwing(String(prop));
    },
  });
}

const host: SkillHost = buildTestHost();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(
  meetingId: string,
  {
    method = "POST",
    bearer,
    body,
    rawBody,
  }: {
    method?: string;
    bearer?: string | null;
    body?: unknown;
    rawBody?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (bearer !== undefined && bearer !== null) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  let bodyStr: string | undefined;
  if (rawBody !== undefined) {
    bodyStr = rawBody;
    headers.set("content-type", "application/json");
  } else if (body !== undefined) {
    bodyStr = JSON.stringify(body);
    headers.set("content-type", "application/json");
  }
  return new Request(
    `http://127.0.0.1:8765/v1/internal/meet/${encodeURIComponent(
      meetingId,
    )}/events`,
    { method, headers, body: bodyStr },
  );
}

function makeRouterWithToken(
  meetingId: string,
  token: string,
): { router: MeetSessionEventRouter; seen: Map<string, MeetBotEvent[]> } {
  const router = new MeetSessionEventRouter();
  router.setBotApiTokenResolver((id) => (id === meetingId ? token : null));
  const seen = new Map<string, MeetBotEvent[]>();
  return { router, seen };
}

function transcriptEvent(
  meetingId: string,
  text: string,
  isFinal = true,
): MeetBotEvent {
  return {
    type: "transcript.chunk",
    meetingId,
    timestamp: new Date(0).toISOString(),
    isFinal,
    text,
  };
}

function lifecycleEvent(meetingId: string): MeetBotEvent {
  return {
    type: "lifecycle",
    meetingId,
    timestamp: new Date(0).toISOString(),
    state: "joined",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleMeetInternalEvents — auth", () => {
  test("no active session for meetingId → 401", async () => {
    const router = new MeetSessionEventRouter();
    // Default resolver rejects all.
    const req = buildRequest("m1", {
      bearer: "anything",
      body: [lifecycleEvent("m1")],
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("missing Authorization header → 401", async () => {
    const { router } = makeRouterWithToken("m1", "secret");
    const req = buildRequest("m1", { body: [lifecycleEvent("m1")] });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(401);
  });

  test("wrong bearer token → 401", async () => {
    const { router } = makeRouterWithToken("m1", "secret");
    const req = buildRequest("m1", {
      bearer: "not-the-real-one",
      body: [lifecycleEvent("m1")],
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(401);
  });

  test("non-Bearer Authorization scheme → 401", async () => {
    const { router } = makeRouterWithToken("m1", "secret");
    const req = new Request("http://127.0.0.1/v1/internal/meet/m1/events", {
      method: "POST",
      headers: {
        authorization: "Basic c2VjcmV0Og==",
        "content-type": "application/json",
      },
      body: JSON.stringify([lifecycleEvent("m1")]),
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(401);
  });
});

describe("handleMeetInternalEvents — success path", () => {
  test("valid batch → 204, each event dispatched", async () => {
    const router = new MeetSessionEventRouter();
    router.setBotApiTokenResolver((id) => (id === "m1" ? "tok-1" : null));
    const received: MeetBotEvent[] = [];
    router.register("m1", (event) => received.push(event));

    const batch: MeetBotEvent[] = [
      lifecycleEvent("m1"),
      transcriptEvent("m1", "hello"),
      transcriptEvent("m1", "world", false),
    ];
    const req = buildRequest("m1", { bearer: "tok-1", body: batch });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(204);
    expect(received).toEqual(batch);
  });

  test("empty batch → 204, no dispatches", async () => {
    const router = new MeetSessionEventRouter();
    router.setBotApiTokenResolver(() => "tok-1");
    const received: MeetBotEvent[] = [];
    router.register("m1", (event) => received.push(event));

    const req = buildRequest("m1", { bearer: "tok-1", body: [] });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(204);
    expect(received).toEqual([]);
  });

  test("valid batch with no registered handler → 204, events drop", async () => {
    const router = new MeetSessionEventRouter();
    router.setBotApiTokenResolver(() => "tok-1");
    // No register() call — dispatch is a no-op by design.

    const req = buildRequest("m1", {
      bearer: "tok-1",
      body: [lifecycleEvent("m1")],
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(204);
  });

  test("bearer with surrounding whitespace still matches", async () => {
    const router = new MeetSessionEventRouter();
    router.setBotApiTokenResolver(() => "tok-1");
    const received: MeetBotEvent[] = [];
    router.register("m1", (event) => received.push(event));

    const req = new Request("http://127.0.0.1/v1/internal/meet/m1/events", {
      method: "POST",
      headers: {
        authorization: "  Bearer   tok-1  ",
        "content-type": "application/json",
      },
      body: JSON.stringify([lifecycleEvent("m1")]),
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(204);
    expect(received).toHaveLength(1);
  });
});

describe("handleMeetInternalEvents — body validation", () => {
  test("malformed JSON → 400", async () => {
    const { router } = makeRouterWithToken("m1", "tok");
    const req = buildRequest("m1", { bearer: "tok", rawBody: "not-json{" });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("body that is not an array → 400", async () => {
    const { router } = makeRouterWithToken("m1", "tok");
    const req = buildRequest("m1", {
      bearer: "tok",
      body: { not: "an array" },
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(400);
  });

  test("unknown event `type` → 400", async () => {
    const { router } = makeRouterWithToken("m1", "tok");
    const req = buildRequest("m1", {
      bearer: "tok",
      body: [
        {
          type: "mystery.event",
          meetingId: "m1",
          timestamp: new Date(0).toISOString(),
        },
      ],
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(400);
  });

  test("transcript.chunk missing required `text` → 400", async () => {
    const { router } = makeRouterWithToken("m1", "tok");
    const req = buildRequest("m1", {
      bearer: "tok",
      body: [
        {
          type: "transcript.chunk",
          meetingId: "m1",
          timestamp: new Date(0).toISOString(),
          isFinal: true,
          // text omitted
        },
      ],
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(400);
  });

  test("one invalid event in an otherwise-valid batch fails the whole batch", async () => {
    const router = new MeetSessionEventRouter();
    router.setBotApiTokenResolver(() => "tok");
    const received: MeetBotEvent[] = [];
    router.register("m1", (event) => received.push(event));

    const req = buildRequest("m1", {
      bearer: "tok",
      body: [
        lifecycleEvent("m1"),
        { type: "not.a.real.type", meetingId: "m1", timestamp: "t" },
      ],
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(400);
    // Importantly: the valid event was NOT dispatched — we reject the
    // batch atomically to avoid leaking a partial event stream.
    expect(received).toEqual([]);
  });

  test("event meetingId mismatch with path → 400, atomic reject (no dispatch)", async () => {
    const router = new MeetSessionEventRouter();
    router.setBotApiTokenResolver(() => "tok");
    const received: MeetBotEvent[] = [];
    router.register("m1", (event) => received.push(event));

    // Register an m2 handler too, to make sure cross-routing is prevented.
    const m2Events: MeetBotEvent[] = [];
    router.register("m2", (event) => m2Events.push(event));

    const req = buildRequest("m1", {
      bearer: "tok",
      body: [lifecycleEvent("m1"), lifecycleEvent("m2")],
    });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(400);
    // Atomic rejection: a mid-batch mismatch aborts the whole batch and
    // no events are dispatched — neither the prior valid event nor
    // anything after. This matches the schema-validation behavior.
    expect(received).toEqual([]);
    expect(m2Events).toEqual([]);
  });
});

describe("handleMeetInternalEvents — method enforcement", () => {
  test("GET → 405 with Allow: POST", async () => {
    const { router } = makeRouterWithToken("m1", "tok");
    const req = buildRequest("m1", { method: "GET", bearer: "tok" });

    const res = await handleMeetInternalEvents(host, req, "m1", router);

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
