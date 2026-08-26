import { describe, expect, test } from "bun:test";

import { applyCopyContract, TITLE_MAX_WORDS } from "../copy-contract.js";
import type { RenderedChannelCopy } from "../types.js";

function copy(overrides: Partial<RenderedChannelCopy> = {}): RenderedChannelCopy {
  return {
    title: "Backup finished",
    body: "The nightly backup on db-primary completed.",
    ...overrides,
  };
}

const CONTEXT = {
  bucket: "worth_knowing" as const,
  hasAction: true,
  sourceEventName: "example.event",
};

describe("applyCopyContract", () => {
  test("passes conforming copy through untouched", () => {
    const result = applyCopyContract(copy(), CONTEXT);

    expect(result.violations).toEqual([]);
    expect(result.copy?.title).toBe("Backup finished");
    expect(result.copy?.body).toBe(
      "The nightly backup on db-primary completed.",
    );
  });

  test("drops a first-person title rather than letting it stand as a headline", () => {
    // "I wrote something about the rendere…" is what a first-person title
    // looks like: a sentence sliced off the body, not a name for anything.
    const result = applyCopyContract(
      copy({ title: "I wrote something about the renderer" }),
      CONTEXT,
    );

    expect(result.violations).toContain("title_first_person");
    expect(result.copy?.title).toBe("");
    // The body survives: the notification still says what happened.
    expect(result.copy?.body).toBe(
      "The nightly backup on db-primary completed.",
    );
  });

  test("trims a title past the word ceiling instead of dropping it", () => {
    const long =
      "Nightly backup on the primary database cluster finished successfully after retries";
    const result = applyCopyContract(copy({ title: long }), CONTEXT);

    expect(result.violations).toContain("title_too_long");
    expect(result.copy?.title?.split(" ")).toHaveLength(TITLE_MAX_WORDS);
  });

  test("drops a title that is only the opening of the body", () => {
    const result = applyCopyContract(
      copy({
        title: "The nightly backup on db-primary…",
        body: "The nightly backup on db-primary completed.",
      }),
      CONTEXT,
    );

    expect(result.violations).toContain("title_prefixes_body");
    expect(result.copy?.title).toBe("");
  });

  test("strips raw error constants from the body", () => {
    const result = applyCopyContract(
      copy({
        title: "Backup failed",
        body: "The backup did not finish (PROVIDER_API_TIMEOUT).",
      }),
      CONTEXT,
    );

    expect(result.violations).toContain("body_raw_error_constant");
    expect(result.copy?.body).toBe("The backup did not finish.");
  });

  test("leaves ordinary two-segment acronyms alone", () => {
    // The rule targets screaming-snake error constants, not the acronyms and
    // product names that appear in real copy. Over-matching here would cost
    // more than the constants do.
    const body = "Add an API_KEY to finish connecting.";
    const result = applyCopyContract(
      copy({ title: "Connection needs a key", body }),
      CONTEXT,
    );

    expect(result.violations).not.toContain("body_raw_error_constant");
    expect(result.copy?.body).toBe(body);
  });

  test("rejects copy with no body: a notification with nothing to say", () => {
    const result = applyCopyContract(copy({ body: "   " }), CONTEXT);

    expect(result.copy).toBeNull();
    expect(result.violations).toEqual(["body_missing"]);
  });

  test("flags a needs-you row with nothing to do about it", () => {
    const result = applyCopyContract(copy(), {
      ...CONTEXT,
      bucket: "needs_you",
      hasAction: false,
    });

    expect(result.violations).toContain("needs_you_without_action");
    // Reported, not suppressed: dropping an approval because its card had no
    // button trades a copy defect for a correctness one.
    expect(result.copy).not.toBeNull();
  });

  test("repeated calls do not drift, so a global regex cannot leak state", () => {
    const input = copy({ body: "It failed (PROVIDER_API_TIMEOUT)." });
    const first = applyCopyContract(input, CONTEXT);
    const second = applyCopyContract(input, CONTEXT);

    expect(second.violations).toEqual(first.violations);
    expect(second.copy?.body).toBe(first.copy?.body);
  });
});
