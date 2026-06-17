import { describe, expect, test } from "bun:test";

import { isLocalMetaCommand } from "@/domains/chat/components/chat-composer/slash-command-catalog";

describe("isLocalMetaCommand", () => {
  test("recognises the local meta commands", () => {
    for (const cmd of ["/clean", "/status", "/commands", "/models"]) {
      expect(isLocalMetaCommand(cmd)).toBe(true);
    }
  });

  test("tolerates surrounding whitespace, trailing args, and case", () => {
    expect(isLocalMetaCommand("  /clean  ")).toBe(true);
    expect(isLocalMetaCommand("/clean foo")).toBe(true);
    expect(isLocalMetaCommand("/CLEAN")).toBe(true);
  });

  test("excludes turn commands and lookalikes", () => {
    // /compact runs the LLM (a real turn); /model switches the profile (a
    // side-effecting command); the rest are non-commands or prefixes.
    for (const cmd of [
      "/compact",
      "/btw",
      "/model",
      "/cleanup",
      "/clean-context",
      "hello",
      "/",
    ]) {
      expect(isLocalMetaCommand(cmd)).toBe(false);
    }
  });
});
