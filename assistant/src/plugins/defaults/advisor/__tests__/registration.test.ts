import { describe, expect, mock, test } from "bun:test";

// Importing the advisor tool transitively loads `consult.ts`, which imports the
// Vellum inference boundary. Mock that boundary so this test exercises only the
// tool-registration mechanism (no provider/network).
const realProviderSendMessage =
  await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realProviderSendMessage,
  getConfiguredProvider: async () => null,
}));
mock.module("../../../../runtime/btw-sidechain.js", () => ({
  runBtwSidechain: async () => ({
    text: "",
    hadTextDeltas: false,
    response: {},
  }),
}));

const { finalizeTool } = await import("../../../../tools/tool-defaults.js");
const { registerPluginTools, getTool, unregisterPluginTools } =
  await import("../../../../tools/registry.js");
const advisorTool = (await import("../tools/advisor.js")).default;

describe("advisor tool registration", () => {
  test("the finalized advisor tool registers into the model-visible catalog", () => {
    // Mirrors what `bootstrapPlugins` does with a default plugin's `tools[]`.
    registerPluginTools("default-advisor", [
      finalizeTool(advisorTool, "advisor"),
    ]);
    try {
      const tool = getTool("advisor");
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("advisor");
      // Plugin tools are stamped with the "plugin" category by the registry.
      expect(tool?.category).toBe("plugin");
      // No-arg tool: empty object schema.
      expect(tool?.input_schema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
      expect(typeof tool?.execute).toBe("function");
    } finally {
      unregisterPluginTools("default-advisor");
    }
    expect(getTool("advisor")).toBeUndefined();
  });
});
