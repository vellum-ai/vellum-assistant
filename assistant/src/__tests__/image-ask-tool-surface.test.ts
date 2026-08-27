/**
 * The shipped `image_ask` surface, exercised through the real registration and
 * gating path rather than the plugin's own mocks.
 *
 * The tool only earns its place if it is genuinely absent from a turn whose
 * model can see images, so these tests register the default plugin's actual
 * tool contribution into the real registry and run the host's own
 * `isToolActiveForContext` over real catalog model ids.
 */

import { afterAll, describe, expect, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import { isToolActiveForContext } from "../daemon/conversation-tool-setup.js";
import { defaultImageFallbackPlugin } from "../plugins/defaults/index.js";
import {
  getTool,
  getToolOwner,
  registerPluginTools,
  unregisterPluginTools,
} from "../tools/registry.js";
import { RiskLevel } from "../tools/tool-types.js";

/** A catalog model that can process image input, and one that cannot. */
const VISION_MODEL = "claude-opus-5";
const TEXT_ONLY_MODEL = "accounts/fireworks/models/glm-5p2";

const PLUGIN_NAME = defaultImageFallbackPlugin.manifest.name;

registerPluginTools(PLUGIN_NAME, defaultImageFallbackPlugin.tools ?? []);

afterAll(() => {
  unregisterPluginTools(PLUGIN_NAME);
});

function conversation(currentTurnModel: string): Conversation {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {},
    toolsDisabledDepth: 0,
    hasNoClient: false,
    currentTurnModel,
  } as unknown as Conversation;
}

describe("image_ask on the shipped tool surface", () => {
  test("the image-fallback plugin contributes it", () => {
    expect(getTool("image_ask")).toBeDefined();
    expect(getToolOwner("image_ask")).toEqual({
      kind: "plugin",
      id: PLUGIN_NAME,
    });
  });

  test("stays off the wire for a model that can see images", () => {
    expect(
      isToolActiveForContext("image_ask", conversation(VISION_MODEL)),
    ).toBe(false);
  });

  test("reaches the wire for a text-only model", () => {
    expect(
      isToolActiveForContext("image_ask", conversation(TEXT_ONLY_MODEL)),
    ).toBe(true);
  });

  test("declares the low risk band and runs in the sandbox", () => {
    const tool = getTool("image_ask");
    expect(tool?.defaultRiskLevel).toBe(RiskLevel.Low);
    expect(tool?.executionTarget).toBe("sandbox");
  });
});
