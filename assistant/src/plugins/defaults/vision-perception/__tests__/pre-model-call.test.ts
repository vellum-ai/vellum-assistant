import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  FileContent,
  ImageContent,
  Message,
} from "../../../../providers/types.js";

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

// Attachment-store lookup supplies the marker's filename and (for the video
// file-block path) the attachment `kind`. Configurable per test.
let attachmentRows: Record<string, { originalFilename: string; kind: string }> =
  {};
mock.module("../../../../memory/attachments-store.js", () => ({
  getAttachmentById: (id: string) => attachmentRows[id] ?? null,
}));

// Whether the visionPerception call site resolves to an enabled vision-capable
// provider. The shared `isVisionPerceptionActiveForTurn` predicate folds this in
// alongside the backbone capability. Configurable per test.
let visionProviderAvailable = true;
mock.module("../src/vision-capability.js", () => ({
  isVisionPerceptionProviderAvailable: () => visionProviderAvailable,
  VISION_CALL_SITE: "visionPerception",
}));

const {
  applyVisionPerceptionMarkers,
  resolveBackboneSupportsVision,
  isVisionPerceptionActiveForTurn,
  isVlmToolName,
} = await import("../hooks/pre-model-call.js");

// Vision-capable (anthropic/claude-opus-4-8) and text-only (fireworks/glm-5p2)
// catalog entries.
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

function fileMessage(
  block: Partial<FileContent> & { type?: "file" } = {},
): Message {
  const fileBlock: FileContent = {
    type: "file",
    source: {
      type: "base64",
      media_type: block.source?.media_type ?? "application/pdf",
      data: "AAAA",
      filename: block.source?.filename ?? "doc.pdf",
    },
    ...(block._attachmentId ? { _attachmentId: block._attachmentId } : {}),
  };
  return { role: "user", content: [{ type: "text", text: "look" }, fileBlock] };
}

const resolutionOpts = {
  callSite: "mainAgent" as const,
  overrideProfile: null,
  selectionSeed: "conv-1",
};

const gate = () => resolveBackboneSupportsVision(resolutionOpts);

// Single supportsVision decision passed to `applyVisionPerceptionMarkers`,
// resolved the same way the agent loop does.
const supportsVision = () => resolveBackboneSupportsVision(resolutionOpts);

beforeEach(() => {
  flagEnabled = true;
  visionProviderAvailable = true;
  resolvedProviderModel = { ...VISION_MODEL };
  attachmentRows = {
    "att-1": { originalFilename: "photo.png", kind: "image" },
    "vid-1": { originalFilename: "clip.mp4", kind: "video" },
    "doc-1": { originalFilename: "report.pdf", kind: "document" },
  };
});

describe("vision-capable backbone keeps the feature inert", () => {
  test("vlm_* tools are not offered and ALL media blocks pass through unchanged", () => {
    resolvedProviderModel = { ...VISION_MODEL };

    // Tool gate: a vision-capable backbone reports supportsVision === true,
    // which the tool resolver reads as "omit all the vlm_* tools".
    expect(gate()).toBe(true);
    expect(isVlmToolName("vlm_ask")).toBe(true);
    expect(isVlmToolName("vlm_video_log")).toBe(true);

    // Image media passes through untouched (same reference, raw image preserved).
    const messages = [imageMessage("att-1")];
    const out = applyVisionPerceptionMarkers(messages, supportsVision());
    expect(out).toBe(messages);
    expect(out[0].content[1]).toMatchObject({ type: "image" });
  });

  test("video media ALSO passes through unchanged on a vision-capable backbone (single gate)", () => {
    // Reverts the per-modality video carve-out: a vision-capable backbone is
    // fully inert, so an uploaded video is NOT rewritten into a marker.
    resolvedProviderModel = { ...VISION_MODEL };
    expect(gate()).toBe(true);

    const messages = [
      fileMessage({
        source: {
          type: "base64",
          media_type: "video/mp4",
          data: "AAAA",
          filename: "clip.mp4",
        },
        _attachmentId: "vid-1",
      }),
    ];
    const out = applyVisionPerceptionMarkers(messages, supportsVision());
    expect(out).toBe(messages);
    expect(out[0].content.some((b) => b.type === "file")).toBe(true);
  });
});

describe("text-only backbone surfaces a usable media_ref", () => {
  test("image block becomes a marker whose media_ref is the attachment id; tools stay offered", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };

    // Tool gate: a text-only backbone reports supportsVision === false, which
    // the tool resolver reads as "offer the vlm_* tools".
    expect(gate()).toBe(false);

    const out = applyVisionPerceptionMarkers(
      [imageMessage("att-1")],
      supportsVision(),
    );
    const blocks = out[0].content;

    // The raw image is gone; the model never receives image bytes.
    expect(blocks.some((b) => b.type === "image")).toBe(false);

    // A text marker replaced it, carrying the attachment id as media_ref.
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

  test("a video file block becomes a marker advertising vlm_video_log", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };

    const out = applyVisionPerceptionMarkers(
      [
        fileMessage({
          source: {
            type: "base64",
            media_type: "video/mp4",
            data: "AAAA",
            filename: "clip.mp4",
          },
          _attachmentId: "vid-1",
        }),
      ],
      supportsVision(),
    );
    const blocks = out[0].content;

    // The raw file block is gone; the model never receives video bytes.
    expect(blocks.some((b) => b.type === "file")).toBe(false);

    const marker = blocks.find(
      (b) => b.type === "text" && b.text.includes("id="),
    );
    expect(marker).toBeDefined();
    const text = (marker as { text: string }).text;
    expect(text).toContain("Video attachment available");
    expect(text).toContain('id="vid-1"');
    expect(text).toContain('media_ref="vid-1"');
    expect(text).toContain('file "clip.mp4"');
    expect(text).toContain("vlm_video_log");
  });

  test("a video file block with a generic mime is detected via attachment kind", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };

    const out = applyVisionPerceptionMarkers(
      [
        fileMessage({
          source: {
            type: "base64",
            media_type: "application/octet-stream",
            data: "AAAA",
            filename: "clip.mov",
          },
          _attachmentId: "vid-1",
        }),
      ],
      supportsVision(),
    );
    const blocks = out[0].content;
    expect(blocks.some((b) => b.type === "file")).toBe(false);
    const marker = blocks.find(
      (b) => b.type === "text" && b.text.includes("vlm_video_log"),
    );
    expect(marker).toBeDefined();
    expect((marker as { text: string }).text).toContain('media_ref="vid-1"');
  });

  test("a non-video file block (e.g. a PDF) is left untouched", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };

    const messages = [
      fileMessage({
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "AAAA",
          filename: "report.pdf",
        },
        _attachmentId: "doc-1",
      }),
    ];
    const out = applyVisionPerceptionMarkers(messages, supportsVision());
    // No rewrite was needed, so the same array reference comes back and the file
    // block survives intact.
    expect(out).toBe(messages);
    expect(out[0].content[1]).toMatchObject({ type: "file" });
  });
});

describe("no media attachments", () => {
  test("text-only backbone leaves an attachment-free request unchanged", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const out = applyVisionPerceptionMarkers(messages, supportsVision());
    expect(out).toBe(messages);
  });

  test("an image block without an attachment id is left intact (no usable media_ref)", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };
    const messages = [imageMessage()];
    const out = applyVisionPerceptionMarkers(messages, supportsVision());
    expect(out).toBe(messages);
    expect(out[0].content[1]).toMatchObject({ type: "image" });
  });
});

describe("feature flag gating", () => {
  test("flag off makes a text-only backbone report inert (supportsVision true)", () => {
    flagEnabled = false;
    resolvedProviderModel = { ...NON_VISION_MODEL };
    expect(gate()).toBe(true);

    // With the gate inert, media passes through and no marker is injected.
    const messages = [imageMessage("att-1")];
    expect(applyVisionPerceptionMarkers(messages, supportsVision())).toBe(
      messages,
    );
  });

  test("flag on engages the feature for a text-only backbone", () => {
    flagEnabled = true;
    resolvedProviderModel = { ...NON_VISION_MODEL };
    expect(gate()).toBe(false);
  });
});

// The single predicate both per-turn gates (tool offer + marker rewrite) share,
// so they can never drift. Active only when the backbone is text-only AND the
// visionPerception provider is available.
describe("isVisionPerceptionActiveForTurn (shared gate)", () => {
  const active = () => isVisionPerceptionActiveForTurn(resolutionOpts);

  test("text-only backbone + provider available → active", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };
    visionProviderAvailable = true;
    expect(active()).toBe(true);
  });

  test("text-only backbone + provider UNAVAILABLE → inactive (no markers, no tools)", () => {
    resolvedProviderModel = { ...NON_VISION_MODEL };
    visionProviderAvailable = false;
    expect(active()).toBe(false);

    // The marker rewrite is driven off `!active` as the loop passes it: with the
    // feature inactive, media is left intact rather than stripped to a marker
    // pointing at tools the model was never offered.
    const messages = [imageMessage("att-1")];
    expect(applyVisionPerceptionMarkers(messages, !active())).toBe(messages);
    expect(messages[0].content[1]).toMatchObject({ type: "image" });
  });

  test("vision-capable backbone → inactive regardless of provider availability", () => {
    resolvedProviderModel = { ...VISION_MODEL };
    visionProviderAvailable = true;
    expect(active()).toBe(false);
  });

  test("flag off → inactive even on a text-only backbone with provider available", () => {
    flagEnabled = false;
    resolvedProviderModel = { ...NON_VISION_MODEL };
    visionProviderAvailable = true;
    expect(active()).toBe(false);
  });
});
