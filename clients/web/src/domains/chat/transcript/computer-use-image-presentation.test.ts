import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { deriveTranscriptImagePresentation } from "@/domains/chat/transcript/computer-use-image-presentation";
import type { DisplayAttachment } from "@/types/attachment-types";

function toolCall(
  id: string,
  overrides: Partial<ChatMessageToolCall> = {},
): ChatMessageToolCall {
  return {
    id,
    name: "file_read",
    input: {},
    ...overrides,
  };
}

function attachment(
  id: string,
  overrides: Partial<DisplayAttachment> = {},
): DisplayAttachment {
  return {
    id,
    filename: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl: null,
    ...overrides,
  };
}

function imagesFor(
  presentation: ReturnType<typeof deriveTranscriptImagePresentation>,
  toolCallId: string,
) {
  return presentation.imagesByToolCallId.get(toolCallId) ?? [];
}

describe("deriveTranscriptImagePresentation", () => {
  test("keeps only the final screenshot-bearing computer-use occurrence", () => {
    const presentation = deriveTranscriptImagePresentation(
      [
        toolCall("cu-first", {
          name: "computer_use_click",
          imageAttachmentIds: ["shot-first"],
        }),
        toolCall("cu-selected", {
          name: "computer_use_click",
          imageAttachmentIds: ["shot-selected-1", "shot-selected-2"],
        }),
        toolCall("cu-pending", { name: "computer_use_click" }),
        toolCall("ordinary-later", {
          imageAttachmentIds: ["ordinary-image"],
        }),
      ],
      undefined,
    );

    expect(imagesFor(presentation, "cu-first")).toEqual([]);
    expect(
      imagesFor(presentation, "cu-selected").map((image) => image.id),
    ).toEqual(["shot-selected-2"]);
    expect(presentation.selectedComputerUseImage).toMatchObject({
      id: "shot-selected-2",
      occurrenceKey: "cu-selected:2",
      toolCallId: "cu-selected",
    });
    expect(imagesFor(presentation, "cu-pending")).toEqual([]);
    expect(
      imagesFor(presentation, "ordinary-later").map((image) => image.id),
    ).toEqual(["ordinary-image"]);
  });

  test("selects computer use before attachment and markdown suppression", () => {
    const canonicalAttachments = [
      attachment("shot-ref", { computerUseScreenshot: true }),
      attachment("forked-shot", { computerUseScreenshot: true }),
      attachment("legacy-false", { computerUseScreenshot: false }),
      attachment("legacy-missing"),
      attachment("shot-ref", { filename: "explicit-copy.png" }),
      attachment("report", {
        filename: "report.pdf",
        mimeType: "application/pdf",
      }),
    ];
    const presentation = deriveTranscriptImagePresentation(
      [
        toolCall("cu", {
          name: "computer_use_click",
          result: "Saved /workspace/frame.png",
          imageAttachmentIds: ["shot-ref"],
        }),
      ],
      canonicalAttachments,
      new Set(["frame.png"]),
    );

    expect(imagesFor(presentation, "cu").map((image) => image.id)).toEqual([
      "shot-ref",
    ]);
    expect(
      presentation.visibleAttachments.map((candidate) => [
        candidate.id,
        candidate.filename,
      ]),
    ).toEqual([
      ["legacy-false", "legacy-false.png"],
      ["legacy-missing", "legacy-missing.png"],
      ["shot-ref", "explicit-copy.png"],
      ["report", "report.pdf"],
    ]);
  });

  test("retains marked attachments when no tool representation exists", () => {
    const marked = attachment("fallback", { computerUseScreenshot: true });
    const presentation = deriveTranscriptImagePresentation(
      [toolCall("cu", { name: "computer_use_click" })],
      [marked],
    );

    expect(presentation.imagesByToolCallId.size).toBe(0);
    expect(presentation.visibleAttachments).toEqual([marked]);
  });

  test("treats a reference without preview bytes as a usable representation", () => {
    const presentation = deriveTranscriptImagePresentation(
      [
        toolCall("cu", {
          name: "computer_use_click",
          imageAttachmentIds: ["shot-ref"],
        }),
      ],
      [attachment("fallback", { computerUseScreenshot: true })],
    );

    expect(imagesFor(presentation, "cu")[0]?.previewUrl).toBeNull();
    expect(presentation.visibleAttachments).toEqual([]);
  });

  test("keeps shared attachment ids distinct by tool-call occurrence", () => {
    const presentation = deriveTranscriptImagePresentation(
      [
        toolCall("cu-first", {
          name: "computer_use_click",
          imageAttachmentIds: ["shot-shared"],
        }),
        toolCall("cu-last", {
          name: "computer_use_click",
          imageAttachmentIds: ["shot-shared"],
        }),
      ],
      undefined,
    );

    expect(imagesFor(presentation, "cu-first")).toEqual([]);
    expect(imagesFor(presentation, "cu-last")[0]).toMatchObject({
      id: "shot-shared",
      stripKey: "tool-ref:cu-last:1",
      toolCallId: "cu-last",
    });
  });

  test("preserves full-message indices and suppression for ordinary images", () => {
    const presentation = deriveTranscriptImagePresentation(
      [
        toolCall("cu", {
          name: "skill_execute",
          input: { tool: "computer_use_click" },
          imageDataList: ["AAAA"],
        }),
        toolCall("ordinary-unnamed", {
          name: "",
          imageDataList: ["BBBB"],
        }),
        toolCall("ordinary-embedded", {
          name: "media_generate_image",
          result: "Saved /workspace/embedded.png",
          imageDataList: ["CCCC"],
        }),
      ],
      undefined,
      new Set(["embedded.png"]),
    );

    expect(imagesFor(presentation, "cu")[0]?.filename).toBe(
      "computer-use-click.png",
    );
    expect(imagesFor(presentation, "ordinary-unnamed")[0]?.filename).toBe(
      "image-2.png",
    );
    expect(imagesFor(presentation, "ordinary-embedded")).toEqual([]);
  });

  test("does not mutate caller-owned arrays", () => {
    const calls = Object.freeze([
      toolCall("cu", {
        name: "computer_use_click",
        imageAttachmentIds: ["shot"],
      }),
    ]);
    const attachments = Object.freeze([
      attachment("fallback", { computerUseScreenshot: true }),
    ]);

    const presentation = deriveTranscriptImagePresentation(calls, attachments);

    expect(calls).toHaveLength(1);
    expect(attachments).toHaveLength(1);
    expect(presentation.visibleAttachments).toEqual([]);
  });
});
