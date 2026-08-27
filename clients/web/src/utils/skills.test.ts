import { describe, expect, test } from "bun:test";

import { skillDetailBackState } from "@/utils/skills";

describe("skillDetailBackState", () => {
  test("serializes pathname, search, and hash", () => {
    expect(
      skillDetailBackState({
        pathname: "/assistant/conversations/conv-1",
        search: "?scrollToMessage=msg-9",
        hash: "#top",
      }),
    ).toEqual({
      backTo: "/assistant/conversations/conv-1?scrollToMessage=msg-9#top",
    });
  });

  test("strips auto-send params so a return trip cannot re-send the prompt", () => {
    // Relay callers keep `?prompt=&relay=` in the URL after dispatch
    // (use-auto-send-effects.ts); a preserved copy in the return location
    // would re-send on remount. Unrelated params survive.
    expect(
      skillDetailBackState({
        pathname: "/assistant/conversations/conv-1",
        search: "?prompt=do%20it%20again&relay=tok-1&scrollToMessage=msg-9",
        hash: "",
      }),
    ).toEqual({
      backTo: "/assistant/conversations/conv-1?scrollToMessage=msg-9",
    });
  });

  test("drops the query separator when stripping empties the search", () => {
    expect(
      skillDetailBackState({
        pathname: "/assistant/conversations/conv-1",
        search: "?prompt=hello",
        hash: "",
      }),
    ).toEqual({ backTo: "/assistant/conversations/conv-1" });
  });
});
