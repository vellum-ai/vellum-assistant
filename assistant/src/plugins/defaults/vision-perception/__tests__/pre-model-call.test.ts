import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ImageContent, Message } from "../../../../providers/types.js";

// The gate resolves the turn's effective provider/model via the LLM resolver and
// reads `supportsVision` from the real model catalog, behind the
// `vision-perception` feature flag. We drive all three with controllable mocks.
let flagEnabled = true;
let resolvedProviderModel: { provider: string; model: string } = {
  provider: "anthropic",
  model: "claude-opus-4-8",
};

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({ llm: { profiles: {}, default: {} } }),
}));
mock.module("../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => flagEnabled,
}));
mock.module("../../../../config/llm-resolver.js", () => ({
  resolveCallSiteConfig: () => resolvedProviderModel,
}));

// Attachment-store lookup supplies the marker's filename. Configurable per test.
let attachmentFilenames: Record<string, string> = {};
mock.module("../../../../memory/attachments-store.js", () => ({
  getAttachmentById: (id: string) =>
    attachmentFilenames[id]
      ? { originalFilename: attachmentFilenames[id] }
      : null,
}));

const {
  applyVisionPerceptionMarkers,
  resolveBackboneSupportsVision,
  isVlmToolName,
} = await import("../hooks/pre-model-call.js");

// Vision-capable (anthropic/claude-opus-4-8) and non-vision
// (fireworks/glm-5p2) catalog entries.
const VISION_MODEL = { provider: "anthropic", model: "claude-opus-4-8" };
const NON_VISION_MODEL = {
  provider: "fireworks",
  model: "accounts/fireworks/models/glm-5p2",
};

function imageMessage(attachmentId?: string): Message {
  const block: ImageContent = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
    ...(attachmentId ? { _attachmentId: attachmentId } : {}),
  };
  return { role: "user", content: [{ type: "text", text: "look" }, block] };
}

const gate = () =>
  resolveBackboneSupportsVision({
    callSite: "mainAgent",
    overrideProfile: null,
    selectionSeed: "conv-1",
  });

beforeEach(() => {
  flagEnabled = true;
  resolvedProviderModel = { ...VISION_MODEL };
  attachmentFilenames = { "att-1": "photo.png" };
});

describe("vision-capable backbone keeps the feature inert", () => {
  test("vlm_* tools are not offered and media blocks pass through unchanged", () => {
    resolvedProviderModel = { ...VISION_MODEL };

    // Tool gate: a vision-capable backbone reports supportsVision === true,
    // which the tool resolver reads as "omit the vlm_* tools".
    expect(gate()).toBe(true);
    expect(isVlmToolName("vlm_ask")).toBe(true);

    // Media passes through untouched (same reference, raw image preserved).
    const messages = [imageMessage("att-1")];
    const out = applyVisionPerceptionMarkers(messages, gate());
    expect(out).toBe(messages);
    expect(out[0].content[1]).toMatchObject({ type: "image" });
  });
});

describe("non-vision backbone surfaces a usable media_ref", () => {
  test("image block becomes a marker whose media_ref is the attachment id; tools stay offered", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };

    // Tool gate: a non-vision backbone reports supportsVision === false, which
    // the tool resolver reads as "offer the vlm_* tools".
    expect(gate()).toBe(false);

    const out = applyVisionPerceptionMarkers([imageMessage("att-1")], gate());
    const blocks = out[0].content;

    // The raw image is gone; the model never receives image bytes.
    expect(blocks.some((b) => b.type === "image")).toBe(false);

    // A text marker replaced it, carrying the attachment id as media_ref
    // (closes Codex P1: the uploaded image exposes a usable media_ref).
    const marker = blocks.find(
      (b) => b.type === "text" && b.text.includes("id="),
    );
    expect(marker).toBeDefined();
    const text = (marker as { text: string }).text;
    expect(text).toContain('id="att-1"');
    expect(text).toContain('media_ref="att-1"');
    expect(text).toContain('file "photo.png"');
    expect(text).toContain("vlm_ask");
  });
});

describe("no media attachments", () => {
  test("non-vision backbone leaves an attachment-free request unchanged", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const out = applyVisionPerceptionMarkers(messages, gate());
    expect(out).toBe(messages);
  });

  test("an image block without an attachment id is left intact (no usable media_ref)", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };
    const messages = [imageMessage()];
    const out = applyVisionPerceptionMarkers(messages, gate());
    expect(out).toBe(messages);
    expect(out[0].content[1]).toMatchObject({ type: "image" });
  });
});

describe("feature flag gating", () => {
  test("flag off makes a non-vision backbone report inert (supportsVision true)", () => {
    flagEnabled = false;
    resolvedProviderModel = { ...NON_VISION_MODEL };
    expect(gate()).toBe(true);

    // With the gate inert, media passes through and no marker is injected.
    const messages = [imageMessage("att-1")];
    expect(applyVisionPerceptionMarkers(messages, gate())).toBe(messages);
  });
});
