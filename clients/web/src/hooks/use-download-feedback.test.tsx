import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import * as toastModule from "@vellumai/design-library/components/toast";

interface ToastCall {
  kind: "info" | "success" | "error";
  message: string;
  options?: toastModule.ToastOptions;
}
const toastCalls: ToastCall[] = [];
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: Object.assign((..._args: unknown[]) => {}, {
    info: (message: string, options?: toastModule.ToastOptions) => {
      toastCalls.push({ kind: "info", message, options });
    },
    success: (message: string, options?: toastModule.ToastOptions) => {
      toastCalls.push({ kind: "success", message, options });
    },
    error: (message: string, options?: toastModule.ToastOptions) => {
      toastCalls.push({ kind: "error", message, options });
    },
    warning: () => {},
  }),
}));

const revealDownloadMock = mock((_id: string) => Promise.resolve());
mock.module("@/runtime/downloads", () => ({
  revealDownload: revealDownloadMock,
}));

let hostOS: "macos" | "windows" | null = "macos";
mock.module("@/runtime/platform-detection", () => ({
  detectElectronHostOS: () => hostOS,
}));

const { useDownloadFeedback } = await import("@/hooks/use-download-feedback");
const { publish, __resetForTesting } = await import("@/lib/event-bus");

beforeEach(() => {
  __resetForTesting();
  toastCalls.length = 0;
  revealDownloadMock.mockClear();
  hostOS = "macos";
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useDownloadFeedback", () => {
  test("acknowledges a browser hand-off and names the file", () => {
    renderHook(() => useDownloadFeedback());

    publish("download.started", { filename: "report.pdf" });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]!.kind).toBe("info");
    expect(toastCalls[0]!.options?.description).toContain("report.pdf");
  });

  test("confirms a completed save with a Finder reveal action on macOS", () => {
    renderHook(() => useDownloadFeedback());

    publish("download.done", {
      id: "dl-1",
      filename: "report (1).pdf",
      state: "completed",
    });

    expect(toastCalls).toHaveLength(1);
    const call = toastCalls[0]!;
    expect(call.kind).toBe("success");
    expect(call.options?.description).toBe("report (1).pdf");
    expect(call.options?.action?.label).toBe("Show in Finder");

    call.options?.action?.onClick();
    expect(revealDownloadMock).toHaveBeenCalledWith("dl-1");
  });

  test("labels the reveal action for File Explorer on a Windows host", () => {
    hostOS = "windows";
    renderHook(() => useDownloadFeedback());

    publish("download.done", {
      id: "dl-2",
      filename: "report.pdf",
      state: "completed",
    });

    expect(toastCalls[0]!.options?.action?.label).toBe("Show in File Explorer");
  });

  test("reports an interrupted download as a failure with no reveal action", () => {
    renderHook(() => useDownloadFeedback());

    publish("download.done", { filename: "report.pdf", state: "interrupted" });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]!.kind).toBe("error");
    expect(toastCalls[0]!.options?.action).toBeUndefined();
  });

  test("omits the reveal action when a completed report carries no id", () => {
    renderHook(() => useDownloadFeedback());

    publish("download.done", { filename: "report.pdf", state: "completed" });

    expect(toastCalls[0]!.kind).toBe("success");
    expect(toastCalls[0]!.options?.action).toBeUndefined();
  });
});
