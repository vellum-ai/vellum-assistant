import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import { __clearRegistryForTesting, getTool } from "../tools/registry.js";
import { registerSystemTools } from "../tools/system/register.js";

beforeEach(() => {
  _setOverridesForTesting({});
  __clearRegistryForTesting();
});

afterAll(() => {
  mock.restore();
});

describe("set_permission_mode removal", () => {
  test("tool is not registered when system tools are initialized", () => {
    _setOverridesForTesting({ "permission-controls-v2": true });
    registerSystemTools();

    expect(getTool("set_permission_mode")).toBeUndefined();
  });

  test("tool stays unavailable even when the feature flag is disabled", () => {
    _setOverridesForTesting({ "permission-controls-v2": false });
    registerSystemTools();

    expect(getTool("set_permission_mode")).toBeUndefined();
  });
});
