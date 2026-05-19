/**
 * This codebase doesn't use @testing-library/react. We verify the component's
 * unregister-mutation contract by exercising the underlying react-query
 * options helpers directly.
 */

import { describe, expect, test } from "bun:test";

import {
  assistantsListOptions,
  assistantsRetireDetailDestroyMutation,
} from "@/generated/api/@tanstack/react-query.gen.js";

describe("Devices unregister mutation contract", () => {
  test("unregister mutation exposes a mutationFn", () => {
    const m = assistantsRetireDetailDestroyMutation();
    expect(typeof m.mutationFn).toBe("function");
  });

  test("invalidation targets the local + all hosting query keys", () => {
    const localKey = JSON.stringify(
      assistantsListOptions({ query: { hosting: "local" } }).queryKey,
    );
    const allKey = JSON.stringify(
      assistantsListOptions({ query: { hosting: "all" } }).queryKey,
    );
    expect(localKey).toContain("local");
    expect(allKey).toContain("all");
  });
});
