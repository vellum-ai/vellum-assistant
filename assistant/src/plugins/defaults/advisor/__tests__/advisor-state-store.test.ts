import { afterEach, describe, expect, test } from "bun:test";

import type { Message } from "../../../../providers/types.js";
import {
  getCapture,
  recordMessages,
  recordSystemPrompt,
  resetAdvisorStateForTests,
  seedCapture,
} from "../advisor-state-store.js";

const userMsg = (t: string): Message => ({
  role: "user",
  content: [{ type: "text", text: t }],
});

afterEach(() => {
  resetAdvisorStateForTests();
});

describe("advisor-state-store", () => {
  test("records system prompt and messages independently per conversation", () => {
    recordSystemPrompt("c1", "system A");
    recordMessages("c1", [userMsg("hello")]);
    recordSystemPrompt("c2", "system B");

    expect(getCapture("c1")?.systemPrompt).toBe("system A");
    expect(getCapture("c1")?.messages).toEqual([userMsg("hello")]);
    expect(getCapture("c2")?.systemPrompt).toBe("system B");
    expect(getCapture("c2")?.messages).toEqual([]);
  });

  test("seedCapture and recordMessages snapshot (copy) the array", () => {
    const live: Message[] = [userMsg("one")];
    seedCapture("c1", live);
    live.push(userMsg("two")); // mutate after seeding

    // The stored snapshot must not see the post-seed mutation.
    expect(getCapture("c1")?.messages).toEqual([userMsg("one")]);
  });

  test("getCapture returns undefined for an unseen conversation", () => {
    expect(getCapture("nope")).toBeUndefined();
  });

  test("resetAdvisorStateForTests clears everything", () => {
    recordSystemPrompt("c1", "x");
    resetAdvisorStateForTests();
    expect(getCapture("c1")).toBeUndefined();
  });
});
