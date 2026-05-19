import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../../adapter";
import { assistantContent } from "../run-once";

function event(message: AgentEvent["message"]): AgentEvent {
  return { message };
}

/**
 * Species-specific event-type filtering moved to the adapter layer in PR
 * #31112 — `normalizeVellumEventStream` and `normalizeHermesEventStream`
 * own the "which events carry assistant transcript text" decision. By the
 * time an event reaches `assistantContent`, the adapter has either kept
 * `text`/`chunk` set (transcript) or cleared them (everything else), so
 * this getter is intentionally trivial. The adapter-side filtering is
 * covered in `lib/__tests__/vellum-adapter.test.ts` and
 * `lib/__tests__/hermes-adapter.test.ts`.
 */
describe("assistantContent (trivial getter)", () => {
  test("returns text when set", () => {
    expect(
      assistantContent(event({ type: "assistant_text_delta", text: "hello" })),
    ).toBe("hello");
  });

  test("returns chunk when text is absent", () => {
    expect(
      assistantContent(event({ type: "message_chunk", chunk: "world" })),
    ).toBe("world");
  });

  test("prefers text over chunk when both are set", () => {
    expect(
      assistantContent(
        event({
          type: "message_chunk",
          text: "from-text",
          chunk: "from-chunk",
        }),
      ),
    ).toBe("from-text");
  });

  test("returns undefined when both text and chunk are absent", () => {
    // After adapter-side normalization, non-transcript events arrive
    // here with `text`/`chunk` cleared — even if the underlying event
    // type would otherwise have carried a stringy payload.
    expect(
      assistantContent(event({ type: "user_message_echo" })),
    ).toBeUndefined();
    expect(
      assistantContent(event({ type: "message_complete" })),
    ).toBeUndefined();
  });
});
