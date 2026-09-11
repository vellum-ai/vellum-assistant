import { describe, expect, test } from "bun:test";

import {
  stabilizeSystemPrompt,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../cache-boundary.js";

const HEAD = "# Instructions\n\nBe helpful.";
const RITUAL = "# First-Run Ritual\n\nThis is your first conversation.";
const SERVICES = "# Connected Services\n\n- **google**: Connected";

function prompt(head: string, ...suffix: string[]): string {
  return suffix.length === 0
    ? head
    : [head, suffix.join("\n\n")].join(SYSTEM_PROMPT_CACHE_BOUNDARY);
}

describe("stabilizeSystemPrompt", () => {
  test("an identical rebuild is returned as-is", () => {
    const current = prompt(HEAD, RITUAL);
    expect(stabilizeSystemPrompt(current, current)).toBe(current);
  });

  test("a rebuild that only lost the volatile block keeps the current prompt", () => {
    // The model deleted BOOTSTRAP.md mid-conversation: the ritual section
    // vanishes from the rebuild and, with it, the boundary itself.
    const current = prompt(HEAD, RITUAL);
    expect(stabilizeSystemPrompt(current, prompt(HEAD))).toBe(current);
  });

  test("a rebuild that only gained a volatile block keeps the current prompt", () => {
    // A service connected mid-conversation reaches the next conversation.
    const current = prompt(HEAD);
    expect(stabilizeSystemPrompt(current, prompt(HEAD, SERVICES))).toBe(
      current,
    );
  });

  test("a rebuild that only changed the volatile block keeps the current prompt", () => {
    const current = prompt(HEAD, RITUAL);
    expect(stabilizeSystemPrompt(current, prompt(HEAD, RITUAL, SERVICES))).toBe(
      current,
    );
  });

  test("a rebuild whose head changed is taken whole, volatile block included", () => {
    const current = prompt(HEAD, RITUAL);
    const next = prompt(`${HEAD}\n\n## Persona\n\nA new caller.`, SERVICES);
    expect(stabilizeSystemPrompt(current, next)).toBe(next);
  });

  test("prompts without a boundary compare in full", () => {
    expect(stabilizeSystemPrompt(HEAD, `${HEAD} more`)).toBe(`${HEAD} more`);
  });

  test("an empty current prompt never pins", () => {
    const next = prompt("", RITUAL);
    expect(stabilizeSystemPrompt("", next)).toBe(next);
  });
});
