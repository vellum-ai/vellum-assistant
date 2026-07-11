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
  mock.restore();
});

describe("set_permission_mode removal", () => {
  test("tool is not registered by initializeTools", async () => {
    await initializeTools();

    expect(getTool("set_permission_mode")).toBeUndefined();
  });
});
