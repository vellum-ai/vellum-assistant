/**
 * Host UI-snapshot executor — handles `host_ui_snapshot_request` by rendering
 * a staged view of the app's own UI (`/assistant/theme-stage/:view`) in a
 * hidden offscreen BrowserWindow, capturing it with
 * `webContents.capturePage()`, and posting the PNG back to the daemon.
 *
 * The staged views contain only fixed generic content — never user data —
 * with the workspace-theme tokens from the request applied. The stage page
 * signals paint-settled readiness by setting `document.title` to the ready
 * sentinel after fonts load and two frames paint; capture waits for that
 * sentinel (bounded by a watchdog) so screenshots are deterministic.
 *
 * The capture pipeline is dependency-injected so tests exercise the
 * dispatch/cancel/post lifecycle without a real BrowserWindow.
 */

import { app } from "electron";
import { z } from "zod";

import { getDevRendererBase, RENDERER_BASE_PROD } from "../app-config";
import type { HostProxyExecutor } from "../host-proxy-router";
import type {
  HostProxyPoster,
  HostUiSnapshotResultPayload,
} from "../host-proxy-poster";
import type { HostProxySseMessage } from "../host-proxy-sse";
import { createWindow } from "../windows";
import log from "../logger";

/** Must match THEME_STAGE_READY_TITLE in the web client's theme-stage page. */
const READY_TITLE = "__THEME_STAGE_READY__";

/** Watchdog for load + fonts + paint of the staged view. */
const READY_TIMEOUT_MS = 10_000;

/** Settle delay before the recapture fallback when the first frame is empty. */
const EMPTY_CAPTURE_RETRY_DELAY_MS = 150;

/** Logical window sizes per staged view (capture is at device scale). */
const VIEW_SIZES: Record<"sampler" | "chat", { width: number; height: number }> = {
  sampler: { width: 720, height: 1080 },
  chat: { width: 720, height: 760 },
};

const REQUEST_SCHEMA = z.object({
  requestId: z.string().min(1),
  view: z.enum(["sampler", "chat"]),
  tokens: z.record(z.string(), z.string()).optional(),
});

export interface StagedCaptureResult {
  pngBase64: string;
  widthPx: number;
  heightPx: number;
}

export type StagedCaptureFn = (
  view: "sampler" | "chat",
  tokens: Record<string, string> | undefined,
  signal: AbortSignal,
) => Promise<StagedCaptureResult>;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Production capture: hidden offscreen window → staged route → ready
 * sentinel → capturePage → PNG. The window is destroyed on every path,
 * including abort (cancel from the daemon).
 */
async function captureStagedView(
  view: "sampler" | "chat",
  tokens: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<StagedCaptureResult> {
  const base = app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase();
  const query = tokens ? `?tokens=${encodeURIComponent(JSON.stringify(tokens))}` : "";
  const url = `${base}/theme-stage/${view}${query}`;
  const { width, height } = VIEW_SIZES[view];

  const win = createWindow({
    browserWindow: {
      width,
      height,
      x: -10_000,
      y: -10_000,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
    },
    navigation: "deny-all",
  });

  try {
    // A hidden window throttles timers and rAF by default, which would stall
    // the stage's double-rAF ready signal.
    win.webContents.setBackgroundThrottling(false);

    const ready = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(watchdog);
        win.webContents.removeListener("page-title-updated", onTitle);
        signal.removeEventListener("abort", onAbort);
      };
      const watchdog = setTimeout(() => {
        cleanup();
        reject(new Error(`Staged view did not become ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);
      const onTitle = (_event: unknown, title: string) => {
        if (title === READY_TITLE) {
          cleanup();
          resolve();
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Snapshot cancelled"));
      };
      signal.addEventListener("abort", onAbort);
      win.webContents.on("page-title-updated", onTitle);

      win.webContents.once("did-fail-load", (_event, code, description) => {
        cleanup();
        reject(new Error(`Staged view failed to load: ${description} (${code})`));
      });

      void win.loadURL(url).catch((err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    await ready;

    let image = await win.webContents.capturePage();
    if (image.isEmpty()) {
      // `paintWhenInitiallyHidden` should composite hidden windows, but if
      // the platform returned a blank frame, show it offscreen and retry.
      win.showInactive();
      await delay(EMPTY_CAPTURE_RETRY_DELAY_MS);
      image = await win.webContents.capturePage();
    }
    if (image.isEmpty()) {
      throw new Error("Capture produced an empty image");
    }

    const size = image.getSize();
    return {
      pngBase64: image.toPNG().toString("base64"),
      widthPx: size.width,
      heightPx: size.height,
    };
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

export interface HostUiSnapshotExecutorDeps {
  capture?: StagedCaptureFn;
}

export function createHostUiSnapshotExecutor(
  deps: HostUiSnapshotExecutorDeps = {},
): HostProxyExecutor {
  const capture = deps.capture ?? captureStagedView;
  const inFlight = new Map<string, AbortController>();

  return {
    handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void {
      const parsed = REQUEST_SCHEMA.safeParse(message);
      if (!parsed.success) {
        const requestId =
          typeof message.requestId === "string" ? message.requestId : undefined;
        log.warn("[host-ui-snapshot] invalid request", { issues: parsed.error.issues });
        if (requestId) {
          void poster.postUiSnapshotResult({
            requestId,
            isError: true,
            errorMessage: `Invalid snapshot request: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          });
        }
        return;
      }

      const { requestId, view, tokens } = parsed.data;
      if (inFlight.has(requestId)) {
        log.warn("[host-ui-snapshot] duplicate request, ignoring", { requestId });
        return;
      }

      const controller = new AbortController();
      inFlight.set(requestId, controller);

      void (async () => {
        let payload: HostUiSnapshotResultPayload;
        try {
          const result = await capture(view, tokens, controller.signal);
          payload = { requestId, ...result };
        } catch (err) {
          payload = {
            requestId,
            isError: true,
            errorMessage: err instanceof Error ? err.message : String(err),
          };
        } finally {
          inFlight.delete(requestId);
        }
        // A cancelled request has no consumer; the daemon already resolved it.
        if (!controller.signal.aborted) {
          void poster.postUiSnapshotResult(payload);
        }
      })();
    },

    handleCancel(message: HostProxySseMessage): void {
      const requestId =
        typeof message.requestId === "string" ? message.requestId : undefined;
      if (!requestId) {
        return;
      }
      inFlight.get(requestId)?.abort();
      inFlight.delete(requestId);
    },
  };
}

export const hostUiSnapshotExecutor = createHostUiSnapshotExecutor();
