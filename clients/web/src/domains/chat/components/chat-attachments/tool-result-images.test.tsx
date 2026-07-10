import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import * as daemonSdk from "@/generated/daemon/sdk.gen";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

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

const { ToolResultImages } = await import(
  "@/domains/chat/components/chat-attachments/tool-result-images"
);

function renderStrip(
  toolCalls: ChatMessageToolCall[],
  opts: { hasAttachments?: boolean; assistantId?: string | null } = {},
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const assistantId = "assistantId" in opts ? opts.assistantId : "asst-1";
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <ToolResultImages
        toolCalls={toolCalls}
        hasAttachments={opts.hasAttachments ?? false}
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

  test("suppresses itself once end-of-turn attachments have arrived", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-suppressed",
      name: "media_generate_image",
      input: {},
      result: "Generated 1 image",
      imageAttachmentIds: ["att-xyz"],
      completedAt: 1,
    };
    renderStrip([toolCall], { hasAttachments: true });

    expect(screen.queryByTestId("tool-result-image")).toBeNull();
    expect(screen.queryByTestId("tool-result-image-placeholder")).toBeNull();
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
  });
});
