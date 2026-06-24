import { beforeEach, describe, expect, test } from "bun:test";

import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";

beforeEach(() => {
  resetPluginRegistryForTests();
});

describe("plugin pipeline", () => {
  test("logs and skips failed hooks while preserving threaded mutations", async () => {
    registerPlugin({
      manifest: {
        name: "test-first-hook",
        version: "1.0.0",
      },
      hooks: {
        "user-prompt-submit": async () => ({
          value: 1,
        }),
      },
    });
    registerPlugin({
      manifest: {
        name: "test-throwing-hook",
        version: "1.0.0",
      },
      hooks: {
        "user-prompt-submit": async () => {
          throw new Error("hook failed");
        },
      },
    });
    registerPlugin({
      manifest: {
        name: "test-final-hook",
        version: "1.0.0",
      },
      hooks: {
        "user-prompt-submit": async (ctx: { value: number }) => ({
          value: ctx.value + 1,
        }),
      },
    });

    const result = await runHook("user-prompt-submit", { value: 0 });

    expect(result).toEqual({ value: 2 });
  });
});
