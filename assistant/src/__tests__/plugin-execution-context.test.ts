import { describe, expect, test } from "bun:test";

import {
  getCurrentPluginName,
  runInPluginContext,
  runOutsidePluginContext,
} from "../plugins/plugin-execution-context.js";

describe("plugin execution context", () => {
  test("reports no plugin outside any context", () => {
    expect(getCurrentPluginName()).toBeUndefined();
  });

  test("marks the plugin for the duration of the call", () => {
    const seen = runInPluginContext("acme", () => getCurrentPluginName());
    expect(seen).toBe("acme");
    expect(getCurrentPluginName()).toBeUndefined();
  });

  test("carries across await boundaries", async () => {
    const seen = await runInPluginContext("acme", async () => {
      await Promise.resolve();
      return getCurrentPluginName();
    });
    expect(seen).toBe("acme");
  });

  test("the innermost plugin wins when contexts nest", () => {
    const seen = runInPluginContext("outer", () =>
      runInPluginContext("inner", () => getCurrentPluginName()),
    );
    expect(seen).toBe("inner");
  });

  describe("runOutsidePluginContext", () => {
    // Host code reached from a plugin (a default tool run during a turn a
    // plugin route started) is not the plugin's code and must not borrow its
    // identity, or a scoped API would attribute that work to the plugin.
    test("clears a surrounding plugin context", () => {
      const seen = runInPluginContext("acme", () =>
        runOutsidePluginContext(() => getCurrentPluginName()),
      );
      expect(seen).toBeUndefined();
    });

    test("keeps the context cleared across await boundaries", async () => {
      const seen = await runInPluginContext("acme", () =>
        runOutsidePluginContext(async () => {
          await Promise.resolve();
          return getCurrentPluginName();
        }),
      );
      expect(seen).toBeUndefined();
    });

    test("restores the plugin context for work after it", () => {
      const seen = runInPluginContext("acme", () => {
        runOutsidePluginContext(() => getCurrentPluginName());
        return getCurrentPluginName();
      });
      expect(seen).toBe("acme");
    });

    test("a plugin context inside it scopes to the inner plugin", () => {
      const seen = runInPluginContext("acme", () =>
        runOutsidePluginContext(() =>
          runInPluginContext("other", () => getCurrentPluginName()),
        ),
      );
      expect(seen).toBe("other");
    });
  });
});
