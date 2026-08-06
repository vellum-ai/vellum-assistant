import { describe, expect, test } from "bun:test";

import { classifySlackEvent } from "./classify-event.js";
import type { SlackInboundEvent } from "./envelope.js";

// The classifier receives tolerantly-parsed events (fields already collapsed to
// their declared types); it discriminates purely on `type` / `subtype`.
const as = (o: Record<string, unknown>): SlackInboundEvent =>
  o as unknown as SlackInboundEvent;

describe("classifySlackEvent", () => {
  test("classifies an app_mention", () => {
    const c = classifySlackEvent(as({ type: "app_mention", user: "U1" }));
    expect(c?.kind).toBe("app_mention");
  });

  test("classifies a plain message (no subtype) as message", () => {
    const c = classifySlackEvent(as({ type: "message", user: "U1" }));
    expect(c?.kind).toBe("message");
  });

  test("classifies a message_changed by subtype", () => {
    const c = classifySlackEvent(
      as({ type: "message", subtype: "message_changed", message: { ts: "1" } }),
    );
    expect(c?.kind).toBe("message_changed");
  });

  test("classifies a message_deleted by subtype", () => {
    const c = classifySlackEvent(
      as({ type: "message", subtype: "message_deleted", deleted_ts: "1" }),
    );
    expect(c?.kind).toBe("message_deleted");
  });

  test("classifies reaction_added and reaction_removed", () => {
    expect(
      classifySlackEvent(as({ type: "reaction_added", reaction: "eyes" }))
        ?.kind,
    ).toBe("reaction_added");
    expect(
      classifySlackEvent(as({ type: "reaction_removed", reaction: "eyes" }))
        ?.kind,
    ).toBe("reaction_removed");
  });

  test("subtype takes precedence over the plain-message fallback", () => {
    // A `message` with an edit/delete subtype must not classify as a plain
    // message — the admit logic and normalizer differ per subtype.
    expect(
      classifySlackEvent(as({ type: "message", subtype: "message_changed" }))
        ?.kind,
    ).not.toBe("message");
  });

  test("an unmodeled message subtype still classifies as a plain message", () => {
    // Only message_changed / message_deleted branch; any other subtype (e.g. a
    // bot_message) falls through to the plain-message kind, matching the
    // dispatch that treats it as a message and lets the normalizer decide.
    const c = classifySlackEvent(
      as({ type: "message", subtype: "bot_message", user: "U1" }),
    );
    expect(c?.kind).toBe("message");
  });

  test("returns null for an event type the dispatch does not handle", () => {
    expect(classifySlackEvent(as({ type: "channel_join" }))).toBeNull();
    expect(classifySlackEvent(as({ type: undefined }))).toBeNull();
    expect(classifySlackEvent(as({}))).toBeNull();
  });

  test("exposes the event on the classified result for typed access", () => {
    const c = classifySlackEvent(
      as({
        type: "message",
        subtype: "message_changed",
        message: { user: "U9" },
      }),
    );
    expect(c?.kind).toBe("message_changed");
    if (c?.kind === "message_changed") {
      expect(c.event.message?.user).toBe("U9");
    }
  });
});
