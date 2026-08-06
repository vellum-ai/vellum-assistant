import { describe, expect, mock, test } from "bun:test";

// Avoid pulling the electron-log file backend into the test process.
mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: {
        file: { maxSize: 0, fileName: "", format: "", getFile: () => ({ path: "" }) },
      },
    },
  };
});

import { createHostUiSnapshotExecutor } from "./host-ui-snapshot-executor";
import type { StagedCaptureFn } from "./host-ui-snapshot-executor";
import type { HostProxyPoster } from "../host-proxy-poster";
import type { HostProxySseMessage } from "../host-proxy-sse";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makePoster() {
  const postUiSnapshotResult = mock(async (_payload: unknown) => true);
  return {
    poster: { postUiSnapshotResult } as unknown as HostProxyPoster,
    postUiSnapshotResult,
  };
}

function request(overrides: Partial<HostProxySseMessage> = {}): HostProxySseMessage {
  return {
    type: "host_ui_snapshot_request",
    requestId: "req-1",
    view: "sampler",
    tokens: { accent: "#e8a04c" },
    ...overrides,
  };
}

describe("hostUiSnapshotExecutor", () => {
  test("captures the requested view and posts the PNG result", async () => {
    const seen: Array<{ view: string; tokens: unknown }> = [];
    const capture: StagedCaptureFn = async (view, tokens) => {
      seen.push({ view, tokens });
      return { pngBase64: "cGluZw==", widthPx: 1440, heightPx: 2160 };
    };
    const executor = createHostUiSnapshotExecutor({ capture });
    const { poster, postUiSnapshotResult } = makePoster();

    executor.handleRequest(request({ view: "chat" }), poster);
    await tick();

    expect(seen).toEqual([{ view: "chat", tokens: { accent: "#e8a04c" } }]);
    expect(postUiSnapshotResult.mock.calls[0]?.[0]).toEqual({
      requestId: "req-1",
      pngBase64: "cGluZw==",
      widthPx: 1440,
      heightPx: 2160,
    });
  });

  test("posts an error result when the capture fails", async () => {
    const capture: StagedCaptureFn = async () => {
      throw new Error("render exploded");
    };
    const executor = createHostUiSnapshotExecutor({ capture });
    const { poster, postUiSnapshotResult } = makePoster();

    executor.handleRequest(request(), poster);
    await tick();

    expect(postUiSnapshotResult.mock.calls[0]?.[0]).toEqual({
      requestId: "req-1",
      isError: true,
      errorMessage: "render exploded",
    });
  });

  test("posts an error result for an invalid view", async () => {
    const executor = createHostUiSnapshotExecutor({
      capture: async () => {
        throw new Error("should not run");
      },
    });
    const { poster, postUiSnapshotResult } = makePoster();

    executor.handleRequest(request({ view: "desktop" }), poster);
    await tick();

    const payload = postUiSnapshotResult.mock.calls[0]?.[0] as {
      requestId: string;
      isError?: boolean;
    };
    expect(payload.requestId).toBe("req-1");
    expect(payload.isError).toBe(true);
  });

  test("cancel aborts the in-flight capture and suppresses the post", async () => {
    let releaseCapture: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const capture: StagedCaptureFn = (_view, _tokens, signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        releaseCapture = () => reject(new Error("Snapshot cancelled"));
        signal.addEventListener("abort", () => {
          releaseCapture?.();
        });
      });
    };
    const executor = createHostUiSnapshotExecutor({ capture });
    const { poster, postUiSnapshotResult } = makePoster();

    executor.handleRequest(request(), poster);
    await tick();
    executor.handleCancel(
      { type: "host_ui_snapshot_cancel", requestId: "req-1" },
      poster,
    );
    await tick();

    expect(observedSignal?.aborted).toBe(true);
    expect(postUiSnapshotResult).not.toHaveBeenCalled();
  });

  test("ignores a duplicate request for the same requestId", async () => {
    let captures = 0;
    const capture: StagedCaptureFn = async () => {
      captures += 1;
      return { pngBase64: "cGluZw==", widthPx: 10, heightPx: 10 };
    };
    const executor = createHostUiSnapshotExecutor({ capture });
    const { poster, postUiSnapshotResult } = makePoster();

    executor.handleRequest(request(), poster);
    executor.handleRequest(request(), poster);
    await tick();

    expect(captures).toBe(1);
    expect(postUiSnapshotResult).toHaveBeenCalledTimes(1);
  });
});
