/**
 * Tests for `isReadOnlyApp` — the predicate the Library uses to hide mutation
 * actions (delete / share / deploy) on plugin-bundled apps, which the daemon
 * rejects server-side.
 */

import { expect, test } from "bun:test";

import { isReadOnlyApp } from "@/types/app-types";

test("workspace-origin apps are writable", () => {
  expect(isReadOnlyApp("workspace")).toBe(false);
});

test("plugin-origin apps are read-only", () => {
  expect(isReadOnlyApp("plugin:acme")).toBe(true);
  expect(isReadOnlyApp("plugin:some-other-plugin")).toBe(true);
});

test("an absent origin is treated as writable (never lock down existing apps)", () => {
  expect(isReadOnlyApp(undefined)).toBe(false);
});
