/**
 * End-to-end: the vision-perception feature's two per-turn gates — offer the
 * `vlm_*` tools, and strip uploaded media to `media_ref` markers — must key on
 * the FINAL backbone the `pre-model-call` hook chain resolves, not the
 * pre-routing profile. A per-turn model-router (a `pre-model-call` hook that
 * sets `ctx.modelProfile`) can re-route the call after the early profile is
 * known, so the loop must thread that routed profile into BOTH the tool
 * resolver and the marker rewrite before the provider receives history + tools.
 *
 * Only the provider boundary and the backbone-capability resolution are
 * stubbed: `resolveBackboneSupportsVision` becomes profile-driven (a "vision"
 * profile is vision-capable, a "glm-text-only" profile is text-only). The real
 * `applyVisionPerceptionMarkers`, `isVlmToolName`, and `isToolActiveForContext`
 * run, so the gates are exercised against the actual rewrite + tool-gate logic.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { AgentLoop } from "../agent/loop.js";
import type { PreModelCallContext } from "../plugin-api/types.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { registerPlugin } from "../plugins/registry.js";
import type {
  ImageContent,
  Message,
  ToolDefinition,
} from "../providers/types.js";
import { createMockProvider, textResponse } from "./helpers/mock-provider.js";

// Vision flag on; BYOK provider available — so the only lever left is the
// resolved backbone's vision capability, which we drive per routed profile.
mock.module("../config/vision-perception-flag.js", () => ({
  isVisionPerceptionEnabled: () => true,
  VISION_PERCEPTION_FLAG_KEY: "vision-perception",
}));
mock.module(
  "../plugins/defaults/vision-perception/src/vision-capability.js",
  () => ({
    isVisionPerceptionProviderAvailable: () => true,
    VISION_CALL_SITE: "visionPerception",
  }),
);

// Profile-driven backbone capability: "vision" → vision-capable (feature
// inert), "glm-text-only" (and null/unknown) → text-only (feature engages).
// Keep every other export of the module real so the marker rewrite and the
// vlm_* name predicate run for real.
const realVisionModule =
  await import("../plugins/defaults/vision-perception/hooks/pre-model-call.js");
mock.module(
  "../plugins/defaults/vision-perception/hooks/pre-model-call.js",
  () => ({
    ...realVisionModule,
    resolveBackboneSupportsVision: (opts: { overrideProfile: string | null }) =>
      opts.overrideProfile === "vision",
  }),
);

const { isToolActiveForContext } =
  await import("../daemon/conversation-tool-setup.js");

const VLM_ASK: ToolDefinition = {
  name: "vlm_ask",
  description: "ask about an image",
  input_schema: { type: "object", properties: {} },
};
const READ_FILE: ToolDefinition = {
  name: "read_file",
  description: "read a file",
  input_schema: { type: "object", properties: {} },
};
const ALL_TOOLS = [READ_FILE, VLM_ASK];

function imageUserMessage(): Message {
  const image: ImageContent = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
    _attachmentId: "att-1",
  };
  return {
    role: "user",
    content: [{ type: "text", text: "what is in this picture?" }, image],
  };
}

/**
 * A `resolveTools` closure matching how the conversation wires one: it gates
 * each tool through the real `isToolActiveForContext`, forwarding the routed
 * profile the loop passes (the third arg) so the vlm_* gate keys on the FINAL
 * backbone. Records the routed profile it was called with for assertion.
 */
function makeResolveTools(recorded: { routedProfile?: string | null }) {
  return (_history: Message[], routedOverrideProfile?: string | null) => {
    recorded.routedProfile = routedOverrideProfile;
    const ctx = {
      skillProjectionState: new Map<string, string>(),
      skillProjectionCache: {} as never,
      coreToolNames: new Set<string>(ALL_TOOLS.map((t) => t.name)),
      toolsDisabledDepth: 0,
      conversationId: "vision-routing-itest",
      currentCallSite: "mainAgent" as const,
    };
    return ALL_TOOLS.filter((t) =>
      isToolActiveForContext(t.name, ctx, routedOverrideProfile),
    );
  };
}

/** Register a `pre-model-call` hook that routes the turn to `profile`. */
function registerRoutingHook(profile: string | null): void {
  registerPlugin({
    manifest: { name: "test-model-router", version: "0.0.0" },
    hooks: {
      "pre-model-call": async (ctx: PreModelCallContext) => {
        ctx.modelProfile = profile;
      },
    },
  });
}

function imageBlocksOf(messages: Message[]): ImageContent[] {
  return messages.flatMap((m) =>
    m.content.filter((b): b is ImageContent => b.type === "image"),
  );
}

function markerTextOf(messages: Message[]): string {
  return messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

describe("agent loop — vision gating uses the final routed profile", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("router: vision-capable active profile → GLM-5.2 (text-only) — vlm_* offered + image stripped", async () => {
    // A model-router re-routes a vision-capable active profile to a text-only
    // backbone AFTER the early profile was resolved. Both gates must engage.
    registerRoutingHook("glm-text-only");
    const { provider, calls } = createMockProvider([textResponse("done")]);
    const recorded: { routedProfile?: string | null } = {};

    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "vision-routing-itest",
      tools: ALL_TOOLS,
      resolveTools: makeResolveTools(recorded),
    });

    await loop.run({
      requestId: "req-1",
      messages: [imageUserMessage()],
      onEvent: () => {},
      callSite: "mainAgent",
      // Early (pre-routing) profile is the vision-capable one.
      overrideProfile: "vision",
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(1);
    // The loop forwarded the FINAL routed profile to the tool resolver.
    expect(recorded.routedProfile).toBe("glm-text-only");
    // Tool gate: vlm_* IS offered for the text-only backbone that runs.
    const toolNames = (calls[0].tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("vlm_ask");
    // Marker rewrite: the raw image is stripped to a media_ref marker.
    expect(imageBlocksOf(calls[0].messages)).toHaveLength(0);
    expect(markerTextOf(calls[0].messages)).toContain('media_ref="att-1"');
  });

  test("router: GLM-5.2 active profile → vision-capable model — vlm_* NOT offered + image passes through", async () => {
    // The opposite: a text-only active profile re-routed to a vision-capable
    // backbone. The feature must be fully inert against the model that runs.
    registerRoutingHook("vision");
    const { provider, calls } = createMockProvider([textResponse("done")]);
    const recorded: { routedProfile?: string | null } = {};

    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "vision-routing-itest",
      tools: ALL_TOOLS,
      resolveTools: makeResolveTools(recorded),
    });

    await loop.run({
      requestId: "req-2",
      messages: [imageUserMessage()],
      onEvent: () => {},
      callSite: "mainAgent",
      // Early (pre-routing) profile is the text-only one.
      overrideProfile: "glm-text-only",
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(1);
    expect(recorded.routedProfile).toBe("vision");
    // Tool gate: vlm_* is withheld for the vision-capable backbone that runs.
    const toolNames = (calls[0].tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("vlm_ask");
    expect(toolNames).toContain("read_file");
    // Marker rewrite: the raw image passes through untouched (no marker).
    expect(imageBlocksOf(calls[0].messages)).toHaveLength(1);
    expect(markerTextOf(calls[0].messages)).not.toContain("media_ref");
  });

  test("no routing hook: fixed GLM-5.2 backbone is unchanged — vlm_* offered + image stripped", async () => {
    // The common case: no model-router hook. The early profile == the final
    // profile, so behavior is identical to before the routing fix.
    const { provider, calls } = createMockProvider([textResponse("done")]);
    const recorded: { routedProfile?: string | null } = {};

    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "vision-routing-itest",
      tools: ALL_TOOLS,
      resolveTools: makeResolveTools(recorded),
    });

    await loop.run({
      requestId: "req-3",
      messages: [imageUserMessage()],
      onEvent: () => {},
      callSite: "mainAgent",
      overrideProfile: "glm-text-only",
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(1);
    // No hook routed away, so the final profile is the seeded text-only one.
    expect(recorded.routedProfile).toBe("glm-text-only");
    const toolNames = (calls[0].tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("vlm_ask");
    expect(imageBlocksOf(calls[0].messages)).toHaveLength(0);
    expect(markerTextOf(calls[0].messages)).toContain('media_ref="att-1"');
  });
});
