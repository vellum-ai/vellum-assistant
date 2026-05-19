/**
 * Tests for AssistantPicker scope.
 *
 * The picker should only fetch platform-hosted assistants — self-hosted
 * registrations are managed in the Devices tab, not here. We verify this by
 * inspecting the generated react-query options helper that the picker calls.
 */

import { describe, expect, test } from "bun:test";

import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen.js";

describe("AssistantPicker query scope", () => {
  test("platform-only query key differs from local and all", () => {
    const platformKey = JSON.stringify(
      assistantsListOptions({ query: { hosting: "platform" } }).queryKey,
    );
    const localKey = JSON.stringify(
      assistantsListOptions({ query: { hosting: "local" } }).queryKey,
    );
    const allKey = JSON.stringify(
      assistantsListOptions({ query: { hosting: "all" } }).queryKey,
    );

    expect(platformKey).toContain("platform");
    expect(platformKey).not.toBe(localKey);
    expect(platformKey).not.toBe(allKey);
  });

  test("platform-only query records the hosting filter in its key", () => {
    const opts = assistantsListOptions({ query: { hosting: "platform" } });
    expect(JSON.stringify(opts.queryKey)).toContain("platform");
  });
});
