import { beforeEach, expect, mock, test } from "bun:test";

const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
let failure: string | undefined;
const pdf = Buffer.from("%PDF-1.7\nexample");
mock.module("../pdf-chrome.js", () => ({
  withPdfChrome: async (
    render: (
      transport: {
        send: (
          method: string,
          params?: Record<string, unknown>,
        ) => Promise<unknown>;
      },
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) =>
    render(
      {
        send: async (method: string, params?: Record<string, unknown>) => {
          calls.push({ method, params });
          if (method === failure) {
            throw new Error("Chrome command failed");
          }
          if (method === "Target.createTarget") {
            return { targetId: "target-123" };
          }
          if (method === "Target.attachToTarget") {
            return { sessionId: "session-123" };
          }
          if (method === "Page.getFrameTree") {
            return { frameTree: { frame: { id: "frame-123" } } };
          }
          if (method === "Page.printToPDF") {
            return { data: pdf.toString("base64") };
          }
          return {};
        },
      },
      AbortSignal.timeout(1_000),
    ),
}));
const { renderMarkdownToPDF } = await import("../document-pdf-renderer.js");
beforeEach(() => {
  calls.length = 0;
  failure = undefined;
});

test("renders markdown in an isolated target and decodes the PDF", async () => {
  const result = await renderMarkdownToPDF(
    "Example",
    "# Heading\n\n**Bold** paragraph.",
  );
  expect(result).toEqual(pdf);
  const content = calls.find(
    (call) => call.method === "Page.setDocumentContent",
  );
  expect(content?.params?.html).toContain("<h1>Heading</h1>");
  expect(content?.params?.html).toContain("<strong>Bold</strong>");
  expect(content?.params?.frameId).toBe("frame-123");
  expect(calls.at(-1)?.method).toBe("Page.printToPDF");
});

test.each(["Emulation.setScriptExecutionDisabled", "Network.setBlockedURLs"])(
  "does not load document content when %s fails",
  async (method) => {
    failure = method;
    await expect(
      renderMarkdownToPDF("Example", "<script>alert(1)</script>"),
    ).rejects.toThrow("Chrome command failed");
    expect(
      calls.some((call) => call.method === "Page.setDocumentContent"),
    ).toBe(false);
    expect(calls.some((call) => call.method === "Page.printToPDF")).toBe(false);
  },
);
