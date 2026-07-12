import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __clearRegistryForTesting,
  getTool,
  initializeTools,
} from "../tools/registry.js";

beforeEach(() => {
  __clearRegistryForTesting();
});

afterAll(() => {
  // The test above runs a full initializeTools(), leaving the process-global
  // registry hot; clear it so a combined `bun test` run doesn't leak this
  // initialization into a later file that expects to initialize under its own
  // env/mocks.
  __clearRegistryForTesting();
  mock.restore();
});

describe("set_permission_mode removal", () => {
  test("tool is not registered by initializeTools", async () => {
    await initializeTools();

    expect(getTool("set_permission_mode")).toBeUndefined();
  });
});
