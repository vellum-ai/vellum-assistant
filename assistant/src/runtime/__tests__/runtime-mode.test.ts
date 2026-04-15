/**
 * Tests for `getDaemonRuntimeMode()` — ensures the helper reflects
 * `IS_CONTAINERIZED` environment state via the existing truthy-check
 * semantics shared with `getIsContainerized()`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getDaemonRuntimeMode } from "../runtime-mode.js";

describe("getDaemonRuntimeMode", () => {
  let savedIsContainerized: string | undefined;

  beforeEach(() => {
    savedIsContainerized = process.env.IS_CONTAINERIZED;
  });

  afterEach(() => {
    if (savedIsContainerized === undefined) {
      delete process.env.IS_CONTAINERIZED;
    } else {
      process.env.IS_CONTAINERIZED = savedIsContainerized;
    }
  });

  test("returns 'docker' when IS_CONTAINERIZED=true", () => {
    process.env.IS_CONTAINERIZED = "true";
    expect(getDaemonRuntimeMode()).toBe("docker");
  });

  test("returns 'docker' when IS_CONTAINERIZED=1", () => {
    // Matches the existing truthy-check in getIsContainerized(), which
    // treats "1" as equivalent to "true" for boolean env flags.
    process.env.IS_CONTAINERIZED = "1";
    expect(getDaemonRuntimeMode()).toBe("docker");
  });

  test("returns 'bare-metal' when IS_CONTAINERIZED is unset", () => {
    delete process.env.IS_CONTAINERIZED;
    expect(getDaemonRuntimeMode()).toBe("bare-metal");
  });

  test("returns 'bare-metal' when IS_CONTAINERIZED=false", () => {
    process.env.IS_CONTAINERIZED = "false";
    expect(getDaemonRuntimeMode()).toBe("bare-metal");
  });

  test("returns 'bare-metal' when IS_CONTAINERIZED=0", () => {
    process.env.IS_CONTAINERIZED = "0";
    expect(getDaemonRuntimeMode()).toBe("bare-metal");
  });

  test("returns 'bare-metal' when IS_CONTAINERIZED is an empty string", () => {
    process.env.IS_CONTAINERIZED = "";
    expect(getDaemonRuntimeMode()).toBe("bare-metal");
  });

  test("returns 'bare-metal' for arbitrary non-truthy values", () => {
    process.env.IS_CONTAINERIZED = "yes";
    expect(getDaemonRuntimeMode()).toBe("bare-metal");
  });
});
