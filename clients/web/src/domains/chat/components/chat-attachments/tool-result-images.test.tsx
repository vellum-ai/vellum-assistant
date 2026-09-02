import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import * as daemonSdk from "@/generated/daemon/sdk.gen";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayAttachment } from "@/types/attachment-types";

type ContentResult = { data: Blob | null; error: { message: string } | null };

// Mock only the daemon content endpoint; keep the rest of the generated SDK
// real so any other consumer in the module graph is unaffected.
const attachmentsByIdContentGet = mock(
  async (_opts: {
    path: { assistant_id: string; id: string };
    parseAs?: string;
    throwOnError?: boolean;
  }): Promise<ContentResult> => ({
    data: new Blob(["image-bytes"]),
    error: null,
  }),
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  attachmentsByIdContentGet,
}));

// happy-dom doesn't implement object URLs.
globalThis.URL.createObjectURL = mock(
  (_obj: Blob | MediaSource): string => "blob:tool-image-mock",
);
globalThis.URL.revokeObjectURL = mock((_url: string): void => undefined);

// Downloads lazily import the native-file bridge; stub it so clicking Download
// records the call without touching Capacitor / DOM anchors.
const saveFileMock = mock(
  async (_data: Blob | string, _filename: string): Promise<void> => undefined,
);
mock.module("@/runtime/native-file", () => ({
  saveFile: saveFileMock,
}));

const imagesModule =
  await import("@/domains/chat/components/chat-attachments/tool-result-images");
const { ToolResultImages } = imagesModule;

function renderStrip(
  toolCalls: ChatMessageToolCall[],
  opts: {
    messageAttachments?: DisplayAttachment[];
    assistantId?: string | null;
  } = {},
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const assistantId = "assistantId" in opts ? opts.assistantId : "asst-1";
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <ToolResultImages
        toolCalls={toolCalls}
        messageAttachments={opts.messageAttachments}
        assistantId={assistantId}
      />
    </QueryClientProvider>
  );
  render(ui);
}

afterEach(() => {
  cleanup();
  attachmentsByIdContentGet.mockClear();
  saveFileMock.mockClear();
});

describe("ToolResultImages referenced media", () => {
  test("renders inline base64 images without hitting the daemon", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-b64",
      name: "media_generate_image",
      input: {},
      result: "Generated 1 image",
      imageDataList: ["img-a"],
      completedAt: 1,
    };
    renderStrip([toolCall]);

    const img = screen.getByTestId("tool-result-image");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,img-a");
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
  });

  test("fetches referenced images by id and renders the object URL", async () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-ref",
      name: "media_generate_image",
      input: {},
      result: "Generated 1 image",
      imageAttachmentIds: ["att-xyz"],
      completedAt: 1,
    };
    renderStrip([toolCall]);

    const img = await screen.findByTestId("tool-result-image");
    expect(img.getAttribute("src")).toBe("blob:tool-image-mock");
    expect(attachmentsByIdContentGet).toHaveBeenCalledTimes(1);
    expect(attachmentsByIdContentGet.mock.calls[0]![0]).toMatchObject({
      path: { assistant_id: "asst-1", id: "att-xyz" },
    });
  });

  test("shows a placeholder and never fetches when no assistantId is known", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-ref-noassistant",
      name: "media_generate_image",
      input: {},
      result: "Generated 1 image",
      imageAttachmentIds: ["att-xyz"],
      completedAt: 1,
    };
    renderStrip([toolCall], { assistantId: null });

    expect(screen.getByTestId("tool-result-image-placeholder")).toBeDefined();
    expect(screen.queryByTestId("tool-result-image")).toBeNull();
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
  });

  test("downloading a referenced image fetches its bytes by id", async () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-ref-dl",
      name: "file_read",
      input: {},
      result: "Read 1 image",
      imageAttachmentIds: ["att-dl"],
      completedAt: 1,
    };
    renderStrip([toolCall]);

    const download = screen.getByLabelText("Download file-read.png");
    fireEvent.click(download);

    await waitFor(() => {
      expect(saveFileMock).toHaveBeenCalledTimes(1);
    });
    // Saved from the fetched blob (referenced media has no inline data URL).
    expect(saveFileMock.mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect(saveFileMock.mock.calls[0]![1]).toBe("file-read.png");
  });

  /** A message attachment chip carrying `id`. */
  function attachment(id: string): DisplayAttachment {
    return {
      id,
      filename: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 1,
      previewUrl: null,
    };
  }

  test("drops a referenced image the end-of-turn attachments already show", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-suppressed",
      name: "media_generate_image",
      input: {},
      result: "Generated 1 image",
      imageAttachmentIds: ["att-xyz"],
      completedAt: 1,
    };
    renderStrip([toolCall], { messageAttachments: [attachment("att-xyz")] });

    expect(screen.queryByTestId("tool-result-image")).toBeNull();
    expect(screen.queryByTestId("tool-result-image-placeholder")).toBeNull();
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
  });

  test("keeps a referenced image an unrelated attachment does not cover", () => {
    // An attachment covering some other file (a file the turn wrote, a user
    // upload) says nothing about this image, so the strip still owes it: it is
    // the turn's only rendering of it.
    const toolCall: ChatMessageToolCall = {
      id: "tc-kept",
      name: "media_generate_image",
      input: {},
      result: "Generated 1 image",
      imageAttachmentIds: ["att-image"],
      completedAt: 1,
    };
    renderStrip([toolCall], {
      messageAttachments: [attachment("att-unrelated-doc")],
    });

    expect(
      screen.queryByTestId("tool-result-image") ??
        screen.queryByTestId("tool-result-image-placeholder"),
    ).not.toBeNull();
  });
});

describe("resolveToolResultImages embed dedupe", () => {
  const { resolveToolResultImages, embeddedImageFileNames } = imagesModule;

  /** A `media_generate_image` call shaped like the real one: the saved path
   *  rides in the result prose, alongside the embed hint for the model. */
  function generateCall(savedPaths: string[]): ChatMessageToolCall {
    const saved =
      savedPaths.length === 1
        ? ` Saved to ${savedPaths[0]}.`
        : ` Saved to:\n${savedPaths.map((p) => `- ${p}`).join("\n")}`;
    return {
      id: "tc-gen",
      name: "media_generate_image",
      input: { prompt: "a dashboard" },
      result:
        `Generated ${savedPaths.length} image using gpt-image.${saved}` +
        `\n\nShow the user an image by embedding it in your reply: ` +
        `![description](vellum://workspace/${savedPaths[0]}).`,
      imageDataList: savedPaths.map(() => "aGVsbG8="),
      completedAt: 1,
    };
  }

  test("drops an image the reply embeds by its saved path", () => {
    // The turn's reply presents the image full width where the text refers to
    // it, so the mid-turn strip would be the second copy of the same picture.
    const toolCall = generateCall(["media/generated/dashboard-ui.png"]);
    const embedded = embeddedImageFileNames([
      {
        type: "text",
        text: "here it is:\n\n![UI](vellum://workspace/media/generated/dashboard-ui.png)",
      },
    ]);

    expect(resolveToolResultImages([toolCall], undefined, embedded)).toEqual(
      [],
    );
  });

  test("keeps the image when the reply embeds nothing", () => {
    const toolCall = generateCall(["media/generated/dashboard-ui.png"]);
    const embedded = embeddedImageFileNames([
      { type: "text", text: "generated the image." },
    ]);

    expect(
      resolveToolResultImages([toolCall], undefined, embedded).length,
    ).toBe(1);
  });

  test("keeps the image when the reply embeds a different file", () => {
    const toolCall = generateCall(["media/generated/dashboard-ui.png"]);
    const embedded = embeddedImageFileNames([
      { type: "text", text: "![other](vellum://workspace/media/other.png)" },
    ]);

    expect(
      resolveToolResultImages([toolCall], undefined, embedded).length,
    ).toBe(1);
  });

  test("drops only the variant the reply embeds", () => {
    // Saved paths align positionally with the images the call produced, so a
    // reply that presents one of two variants leaves the other in the strip.
    const toolCall = generateCall([
      "media/generated/logo-a.png",
      "media/generated/logo-b.png",
    ]);
    const embedded = embeddedImageFileNames([
      {
        type: "text",
        text: "![a](vellum://workspace/media/generated/logo-a.png)",
      },
    ]);

    const shown = resolveToolResultImages([toolCall], undefined, embedded);
    expect(shown.length).toBe(1);
  });

  test("drops a referenced image the reply embeds", () => {
    // Referenced media carries an attachment id rather than inline bytes; the
    // saved path in the result is still what the reply embeds.
    const toolCall: ChatMessageToolCall = {
      ...generateCall(["media/generated/dashboard-ui.png"]),
      imageDataList: undefined,
      imageAttachmentIds: ["att-generated"],
    };
    const embedded = embeddedImageFileNames([
      {
        type: "text",
        text: "![UI](vellum://workspace/media/generated/dashboard-ui.png)",
      },
    ]);

    expect(resolveToolResultImages([toolCall], undefined, embedded)).toEqual(
      [],
    );
  });
});
