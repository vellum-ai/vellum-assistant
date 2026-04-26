import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { __clearRegistryForTesting, getTool } from "../tools/registry.js";
import { registerSystemTools } from "../tools/system/register.js";

beforeEach(() => {
  __clearRegistryForTesting();
});

afterAll(() => {
  mock.restore();
});

describe("set_permission_mode removal", () => {
  test("tool is not registered when system tools are initialized", () => {
    registerSystemTools();

    expect(getTool("set_permission_mode")).toBeUndefined();
  });
});
