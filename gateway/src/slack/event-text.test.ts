import { describe, it, expect } from "bun:test";

import { slackEventText, type SlackTextBearingEvent } from "./event-text.js";

// The static types declare `text` as a string, but Socket Mode payloads are
// untrusted — a non-string reaches this code at runtime. Cast through unknown
// to model that in the tests.
function asEvent(value: unknown): SlackTextBearingEvent {
  return value as SlackTextBearingEvent;
}

describe("slackEventText", () => {
  it("returns the text of an app_mention", () => {
    expect(
      slackEventText(asEvent({ type: "app_mention", text: "hello <@U1>" })),
    ).toBe("hello <@U1>");
  });

  it("returns the text of a top-level message", () => {
    expect(slackEventText(asEvent({ type: "message", text: "hi there" }))).toBe(
      "hi there",
    );
  });

  it("returns the edited text of a message_changed event", () => {
    expect(
      slackEventText(
        asEvent({
          type: "message",
          subtype: "message_changed",
          message: { text: "edited" },
        }),
      ),
    ).toBe("edited");
  });

  it("returns undefined for an event with no text-bearing shape", () => {
    expect(
      slackEventText(asEvent({ type: "reaction_added", reaction: "thumbsup" })),
    ).toBeUndefined();
  });

  it("collapses a non-string message text to undefined instead of returning it", () => {
    // The crash this guards: the renderer calls `text.matchAll`, so a truthy
    // non-string must never leave this function.
    expect(
      slackEventText(asEvent({ type: "message", text: 12345 })),
    ).toBeUndefined();
    expect(
      slackEventText(asEvent({ type: "message", text: { rich: "object" } })),
    ).toBeUndefined();
    expect(
      slackEventText(
        asEvent({
          type: "message",
          subtype: "message_changed",
          message: { text: ["array"] },
        }),
      ),
    ).toBeUndefined();
  });

  it("collapses a missing message body on message_changed to undefined", () => {
    expect(
      slackEventText(asEvent({ type: "message", subtype: "message_changed" })),
    ).toBeUndefined();
  });
});
