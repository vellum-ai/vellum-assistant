import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import * as motionReact from "motion/react";

import { mockAttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-test-helpers";
import * as daemonSdk from "@/generated/daemon/sdk.gen";
import type { ToolResultImage } from "@/domains/chat/components/chat-attachments/tool-result-images";

interface Deferred {
  promise: Promise<void>;
  reject: () => void;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = () => reject(new Error("decode failed"));
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

let reducedMotion = true;
mock.module("motion/react", () => ({
  ...motionReact,
  useReducedMotion: () => reducedMotion,
}));

const contentById = new Map<string, Blob | null>();
const attachmentsByIdContentGet = mock(
  async ({ path }: { path: { id: string } }) => ({
    data: contentById.get(path.id) ?? null,
    error: null,
  }),
);
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  attachmentsByIdContentGet,
}));

const saveFileMock = mock(async () => {});
mock.module("@/runtime/native-file", () => ({ saveFile: saveFileMock }));
const restorePreviewModal = mockAttachmentPreviewModal();

const decodes = new Map<string, Deferred[]>();
const RealImage = globalThis.Image;
class DecodingImage {
  src = "";

  decode(): Promise<void> {
    const next = deferred();
    const pending = decodes.get(this.src) ?? [];
    pending.push(next);
    decodes.set(this.src, pending);
    return next.promise;
  }
}
globalThis.Image = DecodingImage as unknown as typeof Image;

let objectUrlIndex = 0;
const createObjectURL = mock(() => `blob:screenshot-${++objectUrlIndex}`);
const revokeObjectURL = mock((_url: string) => undefined);
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
URL.createObjectURL = createObjectURL;
URL.revokeObjectURL = revokeObjectURL;

const { ComputerUseScreenshotPreview, useComputerUseScreenshotTransition } =
  await import("@/domains/chat/components/chat-attachments/computer-use-screenshot-preview");

function image(
  toolCallId: string,
  source: { inline: string } | { reference: string },
  occurrence = 1,
): ToolResultImage {
  const referenced = "reference" in source;
  const id = referenced
    ? source.reference
    : `tool-image:${toolCallId}:${occurrence}`;
  return {
    id,
    stripKey: `${referenced ? "tool-ref" : "tool-image"}:${toolCallId}:${occurrence}`,
    occurrenceKey: `${toolCallId}:${occurrence}`,
    toolCallId,
    filename: `${toolCallId}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl: referenced ? null : source.inline,
  };
}

function Harness({
  scopeKey = "message-a",
  target,
}: {
  scopeKey?: string;
  target?: ToolResultImage;
}): ReactElement {
  const transition = useComputerUseScreenshotTransition({
    assistantId: "assistant-1",
    scopeKey,
    target,
  });
  return (
    <>
      {target && (
        <ComputerUseScreenshotPreview
          assistantId="assistant-1"
          transition={transition}
        />
      )}
      {transition.previewModal}
    </>
  );
}

function ui(target?: ToolResultImage, scopeKey = "message-a"): ReactElement {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Harness target={target} scopeKey={scopeKey} />
    </QueryClientProvider>
  );
}

function pendingDecode(src: string): Deferred {
  const next = decodes.get(src)?.shift();
  if (!next) {
    throw new Error(`No pending decode for ${src}`);
  }
  return next;
}

async function resolveDecode(src: string): Promise<void> {
  await waitFor(() => expect(decodes.get(src)?.length).toBeGreaterThan(0));
  await act(async () => pendingDecode(src).resolve());
}

beforeEach(() => {
  reducedMotion = true;
  contentById.clear();
  decodes.clear();
  objectUrlIndex = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  attachmentsByIdContentGet.mockClear();
  saveFileMock.mockClear();
});

afterEach(() => cleanup());

afterAll(() => {
  globalThis.Image = RealImage;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  restorePreviewModal();
});

describe("computer-use screenshot transition", () => {
  test("keeps the decoded screenshot until the next screenshot decodes", async () => {
    const first = image("call-a", { inline: "data:image/png;base64,first" });
    const second = image("call-b", { inline: "data:image/png;base64,second" });
    const { rerender } = render(ui(first));

    await resolveDecode(first.previewUrl!);
    expect(
      screen
        .getByTestId("computer-use-screenshot-displayed")
        .getAttribute("src"),
    ).toBe(first.previewUrl);

    rerender(ui(second));
    expect(screen.getByText("Updating screenshot...")).toBeTruthy();
    expect(
      screen
        .getByTestId("computer-use-screenshot-displayed")
        .getAttribute("src"),
    ).toBe(first.previewUrl);
    fireEvent.click(screen.getByRole("button", { name: first.filename }));
    expect(
      screen.getByTestId("preview-modal").getAttribute("data-attachment-id"),
    ).toBe(first.id);

    await resolveDecode(second.previewUrl!);
    await waitFor(() =>
      expect(
        screen
          .getByTestId("computer-use-screenshot-displayed")
          .getAttribute("src"),
      ).toBe(second.previewUrl),
    );
    expect(screen.queryByText("Updating screenshot...")).toBeNull();
  });

  test("ignores a superseded decode that finishes after the newest target", async () => {
    const first = image("call-a", { inline: "data:image/png;base64,first" });
    const second = image("call-b", { inline: "data:image/png;base64,second" });
    const third = image("call-c", { inline: "data:image/png;base64,third" });
    const { rerender } = render(ui(first));
    await resolveDecode(first.previewUrl!);

    rerender(ui(second));
    await waitFor(() =>
      expect(decodes.get(second.previewUrl!)?.length).toBeGreaterThan(0),
    );
    const lateSecond = pendingDecode(second.previewUrl!);
    rerender(ui(third));
    await resolveDecode(third.previewUrl!);
    await act(async () => lateSecond.resolve());

    expect(
      screen
        .getByTestId("computer-use-screenshot-displayed")
        .getAttribute("src"),
    ).toBe(third.previewUrl);
  });

  test("keeps an in-flight inline decode across same-occurrence reference hydration", async () => {
    const inline = image("call-a", { inline: "data:image/png;base64,inline" });
    const referenced = image("call-a", { reference: "attachment-a" });
    const { rerender } = render(ui(inline));
    await waitFor(() =>
      expect(decodes.get(inline.previewUrl!)?.length).toBeGreaterThan(0),
    );

    rerender(ui(referenced));
    await act(async () => pendingDecode(inline.previewUrl!).resolve());

    await waitFor(() =>
      expect(
        screen
          .getByTestId("computer-use-screenshot-displayed")
          .getAttribute("src"),
      ).toBe(inline.previewUrl),
    );
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
    expect(screen.queryByText("Updating screenshot...")).toBeNull();
  });

  test("retains and labels the previous screenshot when the latest decode fails", async () => {
    const first = image("call-a", { inline: "data:image/png;base64,first" });
    const failed = image("call-b", { inline: "data:image/png;base64,failed" });
    const { rerender } = render(ui(first));
    await resolveDecode(first.previewUrl!);

    rerender(ui(failed));
    await waitFor(() =>
      expect(decodes.get(failed.previewUrl!)?.length).toBeGreaterThan(0),
    );
    await act(async () => pendingDecode(failed.previewUrl!).reject());

    await waitFor(() =>
      expect(
        screen.getByText(
          "Latest screenshot unavailable. Showing previous screenshot.",
        ),
      ).toBeTruthy(),
    );
    expect(
      screen
        .getByTestId("computer-use-screenshot-displayed")
        .getAttribute("src"),
    ).toBe(first.previewUrl);
  });

  test("releases a referenced candidate once when its decode fails", async () => {
    const first = image("call-a", { inline: "data:image/png;base64,first" });
    const failed = image("call-b", { reference: "attachment-b" });
    contentById.set("attachment-b", new Blob(["failed"]));
    const { rerender, unmount } = render(ui(first));
    await resolveDecode(first.previewUrl!);

    rerender(ui(failed));
    await waitFor(() =>
      expect(decodes.get("blob:screenshot-1")?.length).toBeGreaterThan(0),
    );
    await act(async () => pendingDecode("blob:screenshot-1").reject());

    await waitFor(() =>
      expect(
        screen.getByText(
          "Latest screenshot unavailable. Showing previous screenshot.",
        ),
      ).toBeTruthy(),
    );
    expect(
      screen
        .getByTestId("computer-use-screenshot-displayed")
        .getAttribute("src"),
    ).toBe(first.previewUrl);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:screenshot-1"]]);

    unmount();
    expect(revokeObjectURL.mock.calls).toEqual([["blob:screenshot-1"]]);
  });

  test("downloads inline displayed bytes without fetching content", async () => {
    const inline = image("call-a", { inline: "data:image/png;base64,inline" });
    render(ui(inline));
    await resolveDecode(inline.previewUrl!);

    fireEvent.click(screen.getByLabelText("Download call-a.png"));

    await waitFor(() => expect(saveFileMock).toHaveBeenCalledTimes(1));
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
  });

  test("shows an unavailable initial frame and resets synchronously across messages", async () => {
    const first = image("call-a", { inline: "data:image/png;base64,first" });
    const failed = image("call-b", { inline: "data:image/png;base64,failed" });
    const { rerender } = render(ui(first));
    await resolveDecode(first.previewUrl!);

    rerender(ui(failed, "message-b"));
    expect(
      screen.queryByTestId("computer-use-screenshot-displayed"),
    ).toBeNull();
    await waitFor(() =>
      expect(decodes.get(failed.previewUrl!)?.length).toBeGreaterThan(0),
    );
    await act(async () => pendingDecode(failed.previewUrl!).reject());

    expect(screen.getByText("Latest screenshot unavailable.")).toBeTruthy();
    expect(
      screen
        .getByTestId("computer-use-screenshot-preview")
        .querySelector(".aspect-\\[16\\/10\\]"),
    ).toBeTruthy();
  });

  test("releases referenced object URLs after replacement and unmount", async () => {
    contentById.set("attachment-a", new Blob(["a"]));
    contentById.set("attachment-b", new Blob(["b"]));
    const first = image("call-a", { reference: "attachment-a" });
    const second = image("call-b", { reference: "attachment-b" });
    const { rerender, unmount } = render(ui(first));

    await resolveDecode("blob:screenshot-1");
    rerender(ui(second));
    await resolveDecode("blob:screenshot-2");
    expect(revokeObjectURL.mock.calls).toEqual([["blob:screenshot-1"]]);

    unmount();
    expect(revokeObjectURL.mock.calls).toEqual([
      ["blob:screenshot-1"],
      ["blob:screenshot-2"],
    ]);
  });

  test("crossfades ready frames unless reduced motion is requested", async () => {
    reducedMotion = false;
    const first = image("call-a", { inline: "data:image/png;base64,first" });
    const second = image("call-b", { inline: "data:image/png;base64,second" });
    const { rerender } = render(ui(first));
    await resolveDecode(first.previewUrl!);
    const initial = await screen.findByTestId(
      "computer-use-screenshot-incoming",
    );
    await waitFor(() => expect(initial.className).toContain("opacity-100"));
    fireEvent.transitionEnd(initial, { propertyName: "opacity" });

    rerender(ui(second));
    await resolveDecode(second.previewUrl!);
    const incoming = await screen.findByTestId(
      "computer-use-screenshot-incoming",
    );
    expect(incoming.className).toContain("duration-150");
    await waitFor(() => expect(incoming.className).toContain("opacity-100"));
    fireEvent.transitionEnd(incoming, { propertyName: "opacity" });
    expect(
      screen
        .getByTestId("computer-use-screenshot-displayed")
        .getAttribute("src"),
    ).toBe(second.previewUrl);
  });
});
