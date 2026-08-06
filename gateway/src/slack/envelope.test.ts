import { describe, it, expect } from "bun:test";

import { parseSlackEnvelope } from "./envelope.js";

describe("parseSlackEnvelope", () => {
  it("parses a well-formed events_api envelope", () => {
    const env = parseSlackEnvelope(
      JSON.stringify({
        envelope_id: "env-1",
        type: "events_api",
        payload: {
          event_id: "Ev1",
          event_time: 1700000000,
          team_id: "T1",
          event: { type: "app_mention", user: "U1", text: "hi", ts: "1.2" },
        },
      }),
    );

    expect(env).not.toBeNull();
    expect(env!.envelope_id).toBe("env-1");
    expect(env!.type).toBe("events_api");
    expect(env!.payload?.event_id).toBe("Ev1");
    expect(env!.payload?.team_id).toBe("T1");
    expect(env!.payload?.event?.type).toBe("app_mention");
  });

  it("parses an interactive envelope, preserving the passthrough payload", () => {
    const env = parseSlackEnvelope(
      JSON.stringify({
        envelope_id: "env-2",
        type: "interactive",
        payload: {
          type: "block_actions",
          trigger_id: "t1",
          user: { id: "U1" },
          actions: [{ action_id: "approve", type: "button" }],
        },
      }),
    );

    expect(env).not.toBeNull();
    expect(env!.type).toBe("interactive");
    // Interactive extras are preserved for normalizeSlackBlockActions.
    expect(env!.payload?.type).toBe("block_actions");
    expect(env!.payload?.trigger_id).toBe("t1");
    expect((env!.payload as Record<string, unknown>).actions).toBeDefined();
  });

  it("parses a disconnect envelope", () => {
    const env = parseSlackEnvelope(
      JSON.stringify({ type: "disconnect", reason: "warning" }),
    );

    expect(env).not.toBeNull();
    expect(env!.type).toBe("disconnect");
    expect(env!.reason).toBe("warning");
  });

  it("returns null for non-JSON input", () => {
    expect(parseSlackEnvelope("not json {")).toBeNull();
    expect(parseSlackEnvelope("")).toBeNull();
  });

  it("returns null for a non-object JSON frame", () => {
    expect(parseSlackEnvelope("42")).toBeNull();
    expect(parseSlackEnvelope('"a string"')).toBeNull();
    expect(parseSlackEnvelope("null")).toBeNull();
    expect(parseSlackEnvelope("[1,2,3]")).toBeNull();
  });

  it("collapses malformed frame fields rather than rejecting the whole envelope", () => {
    // envelope_id / type are non-strings, payload.event is a scalar. Tolerant:
    // each bad field collapses to undefined, the envelope still parses, and the
    // downstream handler drops it on the missing fields.
    const env = parseSlackEnvelope(
      JSON.stringify({
        envelope_id: 123,
        type: { nested: true },
        payload: { event_id: "Ev1", event: "not-an-object" },
      }),
    );

    expect(env).not.toBeNull();
    expect(env!.envelope_id).toBeUndefined();
    expect(env!.type).toBeUndefined();
    expect(env!.payload?.event_id).toBe("Ev1");
    expect(env!.payload?.event).toBeUndefined();
  });

  it("collapses a non-object payload to undefined", () => {
    const env = parseSlackEnvelope(
      JSON.stringify({ type: "events_api", payload: "bogus" }),
    );

    expect(env).not.toBeNull();
    expect(env!.type).toBe("events_api");
    expect(env!.payload).toBeUndefined();
  });
});
