import { desktopCapturer, screen } from "electron";
import { z } from "zod";
import { parseHelperWindows } from "@vellumai/electron-desktop/companion-capture-sources";
import { getSharedCuHelper } from "./features/computer-use-actions";

const captureRequest = z.object({
  displayId: z.number().optional(),
  windowId: z.number().optional(),
  maxWidth: z.number().int().positive().max(1600),
  maxHeight: z.number().int().positive().max(1000),
});

export const callCompanionCapture = async (
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> => {
  const helper = getSharedCuHelper();
  if (method === "captureSources.list") {
    const windows = parseHelperWindows(await helper.call(method, params));
    return {
      windows: windows
        .filter((window) => window.pid !== process.pid)
        .map((window) => ({
          ...window,
          bounds: screen.screenToDipRect(null, window.bounds),
        })),
    };
  }
  if (method === "captureSources.raise") {
    return helper.call(method, params);
  }
  if (method === "ax.locate") {
    const display =
      params?.displayId === undefined
        ? undefined
        : screen
            .getAllDisplays()
            .find((candidate) => candidate.id === params.displayId);
    if (params?.displayId !== undefined && !display) {
      return { found: false, reason: "no-tree" };
    }
    let windowId = params?.windowId;
    if (display) {
      const windows = parseHelperWindows(
        await callCompanionCapture("captureSources.list"),
      );
      const bounds = display.bounds;
      const target = windows.find(
        ({ onScreen, bounds: window }) =>
          onScreen !== false &&
          window.width >= 50 &&
          window.height >= 50 &&
          window.x < bounds.x + bounds.width &&
          window.x + window.width > bounds.x &&
          window.y < bounds.y + bounds.height &&
          window.y + window.height > bounds.y,
      );
      // A straddling window's tree includes content outside the shared frame.
      if (
        !target ||
        target.bounds.x < bounds.x ||
        target.bounds.y < bounds.y ||
        target.bounds.x + target.bounds.width > bounds.x + bounds.width ||
        target.bounds.y + target.bounds.height > bounds.y + bounds.height
      ) {
        return { found: false, reason: "no-tree" };
      }
      windowId = target.windowId;
    }
    const result = await helper.call(method, { ...params, windowId });
    const located = z
      .object({
        found: z.literal(true),
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .safeParse(result);
    return located.success
      ? {
          ...(result as Record<string, unknown>),
          ...screen.screenToDipRect(null, located.data),
        }
      : result;
  }
  if (method !== "capture.frame") {
    throw new Error(`Unsupported companion capture method: ${method}`);
  }
  const request = captureRequest.parse(params);
  const sources = await desktopCapturer.getSources({
    types: [request.windowId === undefined ? "screen" : "window"],
    thumbnailSize: { width: request.maxWidth, height: request.maxHeight },
  });
  const source = sources.find((candidate) =>
    request.windowId === undefined
      ? candidate.display_id === String(request.displayId)
      : candidate.id.split(":")[1] === String(request.windowId),
  );
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("The selected screen or window is unavailable");
  }
  const { width, height } = source.thumbnail.getSize();
  return {
    jpegBase64: source.thumbnail.toJPEG(80).toString("base64"),
    width,
    height,
  };
};
