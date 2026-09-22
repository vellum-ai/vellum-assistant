import { describe, expect, test } from "bun:test";
import { isDraggablePermission } from "@vellumai/ipc-contract";
import {
  permissionAppPath,
  permissionGuideBounds,
} from "./permission-drag-target";

describe("permission drag targets", () => {
  test("uses the correct TCC owner for each draggable pane", () => {
    const executable = "/Applications/Vellum Dev.app/Contents/MacOS/Vellum Dev";
    const helper =
      "/Applications/Vellum Dev.app/Contents/Resources/bin/Vellum Helper Dev.app";
    expect(permissionAppPath("accessibility", executable, helper)).toBe(
      "/Applications/Vellum Dev.app",
    );
    expect(permissionAppPath("screen", executable, helper)).toBe(helper);
    expect(permissionAppPath("inputMonitoring", executable, helper)).toBe(
      helper,
    );
    expect(isDraggablePermission("microphone")).toBe(false);
    expect(isDraggablePermission("automation")).toBe(false);
    expect(isDraggablePermission("speechRecognition")).toBe(false);
  });

  test("anchors inside Settings while leaving the app list above it", () => {
    expect(
      permissionGuideBounds(
        { x: 0, y: 25, width: 1440, height: 875 },
        { x: 100, y: 80, width: 700, height: 700 },
      ),
    ).toEqual({ x: 224, y: 616, width: 560, height: 148 });
  });

  test("clamps to a secondary display with a negative origin", () => {
    const area = { x: -1280, y: -200, width: 1280, height: 800 };
    const bounds = permissionGuideBounds(area, {
      x: -1400,
      y: -300,
      width: 600,
      height: 400,
    });
    expect(bounds.x).toBeGreaterThanOrEqual(area.x + 12);
    expect(bounds.y).toBeGreaterThanOrEqual(area.y + 12);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      area.x + area.width - 12,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      area.y + area.height - 12,
    );
  });
});
