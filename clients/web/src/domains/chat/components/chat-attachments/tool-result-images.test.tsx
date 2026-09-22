import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
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
import { mockAttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolResultImage } from "@/domains/chat/components/chat-attachments/tool-result-images";
import type { DisplayAttachment } from "@/types/attachment-types";

type ContentResult = { data: Blob | null; error: { message: string } | null };
type MetadataResult = {
  data: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    kind: string;
    data: null;
  } | null;
  error: { message: string } | null;
};

const respondsWithBytes = async (): Promise<ContentResult> => ({
  data: new Blob(["image-bytes"]),
  error: null,
});

/** What the content endpoint answers, swapped per test. */
let contentResponse: () => Promise<ContentResult> = respondsWithBytes;
let metadataResponse: () => Promise<MetadataResult> = async () => ({
  data: {
    id: "att-dl",
    filename: "file-read.png",
    mimeType: "image/png",
    sizeBytes: 11,
    kind: "image",
    data: null,
  },
  error: null,
});

// Mock only the daemon content endpoint; keep the rest of the generated SDK
// real so any other consumer in the module graph is unaffected.
const attachmentsByIdContentGet = mock(
  async (_opts: {
    path: { assistant_id: string; id: string };
    parseAs?: string;
    throwOnError?: boolean;
  }): Promise<ContentResult> => contentResponse(),
);
const attachmentsByIdGet = mock(
  async (_opts: {
    path: { assistant_id: string; id: string };
    throwOnError?: boolean;
  }): Promise<MetadataResult> => metadataResponse(),
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  attachmentsByIdContentGet,
  attachmentsByIdGet,
}));

// happy-dom doesn't implement object URLs.
const createObjectUrl = mock(
  (_obj: Blob | MediaSource): string => "blob:tool-image-mock",
);
const revokeObjectUrl = mock((_url: string): void => undefined);
const realCreateObjectURL = globalThis.URL.createObjectURL;
const realRevokeObjectURL = globalThis.URL.revokeObjectURL;
globalThis.URL.createObjectURL = createObjectUrl;
globalThis.URL.revokeObjectURL = revokeObjectUrl;

// Downloads lazily import the native-file bridge; stub it so clicking Download
// records the call without touching Capacitor / DOM anchors.
const saveFileMock = mock(
  async (_data: Blob | string, _filename: string): Promise<void> => undefined,
);
mock.module("@/runtime/native-file", () => ({
  saveFile: saveFileMock,
}));

// The strip's own wiring is what is under test, so the modal is a probe
// reporting which attachment it was handed and at which position.
const restorePreviewModal = mockAttachmentPreviewModal();

const imagesModule =
  await import("@/domains/chat/components/chat-attachments/tool-result-images");
const { ToolResultImages } = imagesModule;
const { projectToolResultImages, resolveToolResultImages } = imagesModule;

interface StripOptions {
  messageAttachments?: DisplayAttachment[];
  resolvedImages?: ToolResultImage[];
  assistantId?: string | null;
  /** Share one client across re-renders so a survivor keeps its cached blob. */
  client?: QueryClient;
}

function stripUi(
  toolCalls: ChatMessageToolCall[],
  opts: StripOptions = {},
): ReactElement {
  const client =
    opts.client ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const assistantId = "assistantId" in opts ? opts.assistantId : "asst-1";
  return (
    <QueryClientProvider client={client}>
      <ToolResultImages
        toolCalls={toolCalls}
        messageAttachments={opts.messageAttachments}
        resolvedImages={opts.resolvedImages}
        assistantId={assistantId}
      />
    </QueryClientProvider>
  );
}

function renderStrip(
  toolCalls: ChatMessageToolCall[],
  opts: StripOptions = {},
): void {
  render(stripUi(toolCalls, opts));
}

afterEach(() => {
  cleanup();
  contentResponse = respondsWithBytes;
  metadataResponse = async () => ({
    data: {
      id: "att-dl",
      filename: "file-read.png",
      mimeType: "image/png",
      sizeBytes: 11,
      kind: "image",
      data: null,
    },
    error: null,
  });
  attachmentsByIdContentGet.mockClear();
  attachmentsByIdGet.mockClear();
  saveFileMock.mockClear();
  createObjectUrl.mockClear();
  revokeObjectUrl.mockClear();
});

// `mock.module` is process-global and the object-URL stubs are on the shared
// global, so both go back before the next file loads.
afterAll(() => {
  globalThis.URL.createObjectURL = realCreateObjectURL;
  globalThis.URL.revokeObjectURL = realRevokeObjectURL;
  restorePreviewModal();
  mock.restore();
});

describe("ToolResultImages referenced media", () => {
  test("uses a supplied message-wide image selection", () => {
    const calls: ChatMessageToolCall[] = [
      {
        id: "tc-first",
        name: "computer_use_screenshot",
        input: {},
        imageDataList: ["first"],
      },
      {
        id: "tc-selected",
        name: "computer_use_screenshot",
        input: {},
        imageDataList: ["selected"],
      },
    ];
    const selected = projectToolResultImages([calls[1]!]);

    renderStrip(calls, { resolvedImages: selected });

    const images = screen.getAllByTestId("tool-result-image");
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute("src")).toBe(
      "data:image/png;base64,selected",
    );
  });

  test("keeps an explicit empty message-wide selection empty", () => {
    renderStrip(
      [
        {
          id: "tc-image",
          name: "computer_use_screenshot",
          input: {},
          imageDataList: ["image"],
        },
      ],
      { resolvedImages: [] },
    );

    expect(screen.queryByTestId("tool-result-image")).toBeNull();
  });

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

    const placeholder = screen.getByTestId("tool-result-image-placeholder");
    // Nothing is on its way, so the box names the file with its kind glyph
    // rather than spinning for bytes that will never arrive.
    expect(placeholder.querySelector(".animate-spin")).toBeNull();
    expect(placeholder.querySelector("svg")).not.toBeNull();
    expect(screen.queryByTestId("tool-result-image")).toBeNull();
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
  });

  test("downloading a referenced image uses its canonical metadata", async () => {
    contentResponse = async () => ({
      data: new Blob(["jpeg-bytes"], { type: "image/jpeg" }),
      error: null,
    });
    metadataResponse = async () => ({
      data: {
        id: "att-dl",
        filename: "capture.jpeg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        kind: "image",
        data: null,
      },
      error: null,
    });
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
    // Saved from the fetched blob and named by the canonical metadata rather
    // than the projection's PNG fallback.
    const saved = saveFileMock.mock.calls[0]![0] as Blob;
    expect(saved).toBeInstanceOf(Blob);
    expect(saved.type).toBe("image/jpeg");
    expect(await saved.text()).toBe("jpeg-bytes");
    expect(saveFileMock.mock.calls[0]![1]).toBe("capture.jpeg");
    expect(attachmentsByIdGet).toHaveBeenCalledTimes(1);
  });

  test("opens the gallery at the clicked image's position when two calls name one id", () => {
    // A turn that reads the same image twice yields two entries under one
    // attachment id, which the modal's id lookup cannot tell apart.
    const calls: ChatMessageToolCall[] = [
      {
        id: "tc-first",
        name: "media_generate_image",
        input: {},
        result: "Generated 1 image",
        imageAttachmentIds: ["att-same"],
        completedAt: 1,
      },
      {
        id: "tc-second",
        name: "file_read",
        input: {},
        result: "Read 1 image",
        imageAttachmentIds: ["att-same"],
        completedAt: 2,
      },
    ];
    renderStrip(calls);

    fireEvent.click(screen.getByRole("button", { name: "file-read.png" }));

    const modal = screen.getByTestId("preview-modal");
    expect(modal.getAttribute("data-attachment-id")).toBe("att-same");
    expect(modal.getAttribute("data-current-index")).toBe("1");
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

  test("names a referenced image whose bytes never arrived", async () => {
    contentResponse = async () => ({ data: null, error: { message: "gone" } });
    const toolCall: ChatMessageToolCall = {
      id: "tc-ref-failed",
      name: "media_generate_image",
      input: {},
      result: "Generated 1 image",
      imageAttachmentIds: ["att-missing"],
      completedAt: 1,
    };
    renderStrip([toolCall]);

    await waitFor(() => {
      expect(
        screen
          .getByTestId("tool-result-image-placeholder")
          .querySelector(".animate-spin"),
      ).toBeNull();
    });
    // The kind glyph stands in for the picture, so the box says a file is
    // there whose bytes could not be drawn.
    expect(
      screen.getByTestId("tool-result-image-placeholder").querySelector("svg"),
    ).not.toBeNull();
    expect(screen.queryByTestId("tool-result-image")).toBeNull();
  });

  test("keeps a surviving image mounted when an earlier one leaves the strip", async () => {
    const calls: ChatMessageToolCall[] = [
      {
        id: "tc-leaves",
        name: "media_generate_image",
        input: {},
        result: "Generated 1 image",
        imageAttachmentIds: ["att-leaves"],
        completedAt: 1,
      },
      {
        id: "tc-stays",
        name: "file_read",
        input: {},
        result: "Read 1 image",
        imageAttachmentIds: ["att-stays"],
        completedAt: 2,
      },
    ];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const strip = (messageAttachments?: DisplayAttachment[]): ReactElement =>
      stripUi(calls, { messageAttachments, client });

    const { rerender } = render(strip());
    const survivor = await screen.findByAltText("file-read.png");
    createObjectUrl.mockClear();

    // The end-of-turn chips take the first image over, so the strip drops it
    // from the middle of the list the second one is keyed in.
    rerender(strip([attachment("att-leaves")]));

    expect(screen.queryByAltText("media-generate-image.png")).toBeNull();
    expect(screen.getByAltText("file-read.png")).toBe(survivor);
    // A remount would have revoked the survivor's object URL and minted a new
    // one, painting the placeholder box for a frame.
    expect(createObjectUrl).not.toHaveBeenCalled();
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

describe("projectToolResultImages", () => {
  test("names wrapped computer-use images from the resolved inner tool", () => {
    const wrapped: ChatMessageToolCall = {
      id: "tc-wrapped",
      name: "skill_execute",
      input: { tool: "computer_use_click" },
      imageDataList: ["AAAA"],
    };
    const malformed: ChatMessageToolCall = {
      ...wrapped,
      id: "tc-malformed",
      input: { _raw: '{"tool":"computer_use_click"}' },
    };

    expect(projectToolResultImages([wrapped])[0]?.filename).toBe(
      "computer-use-click.png",
    );
    expect(projectToolResultImages([malformed])[0]?.filename).toBe(
      "skill-execute.png",
    );
  });

  test("keeps tool-call occurrence identity on inline and referenced images", () => {
    const inline: ChatMessageToolCall = {
      id: "tc-inline",
      name: "computer_use_screenshot",
      input: {},
      imageDataList: ["AAAA"],
    };
    const referenced: ChatMessageToolCall = {
      ...inline,
      imageDataList: undefined,
      imageAttachmentIds: ["att-1"],
    };

    const inlineImage = projectToolResultImages([inline])[0];
    const referencedImage = projectToolResultImages([referenced])[0];

    expect(inlineImage?.toolCallId).toBe("tc-inline");
    expect(referencedImage?.toolCallId).toBe("tc-inline");
    expect(inlineImage?.occurrenceKey).toBe("tc-inline:1");
    expect(referencedImage?.occurrenceKey).toBe(inlineImage?.occurrenceKey);
  });

  test("retains raw images before markdown and reply-attachment suppression", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-raw",
      name: "computer_use_screenshot",
      input: {},
      result: "Saved /workspace/frame.png",
      imageAttachmentIds: ["att-shared"],
    };
    const attachment: DisplayAttachment = {
      id: "att-shared",
      filename: "frame.png",
      mimeType: "image/png",
      sizeBytes: 1,
      previewUrl: null,
    };

    expect(projectToolResultImages([toolCall])).toHaveLength(1);
    expect(
      resolveToolResultImages([toolCall], [attachment], new Set(["frame.png"])),
    ).toHaveLength(0);
  });

  test("keeps two calls sharing one attachment as distinct occurrences", () => {
    const calls: ChatMessageToolCall[] = ["tc-a", "tc-b"].map((id) => ({
      id,
      name: "computer_use_screenshot",
      input: {},
      imageAttachmentIds: ["att-shared"],
    }));

    expect(
      projectToolResultImages(calls).map((image) => [
        image.id,
        image.toolCallId,
      ]),
    ).toEqual([
      ["att-shared", "tc-a"],
      ["att-shared", "tc-b"],
    ]);
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
