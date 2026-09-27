import type { Rectangle } from "electron";
import { PERMISSION_GUIDE_MIN_HEIGHT } from "@vellumai/ipc-contract";

export const GUIDE_WIDTH = 560;
export const GUIDE_HEIGHT = PERMISSION_GUIDE_MIN_HEIGHT;

/** Keep the app list exposed, with the guide tucked against its lower edge. */
export function permissionGuideBounds(
  workArea: Rectangle,
  settings?: Rectangle,
  contentHeight = GUIDE_HEIGHT,
): Rectangle {
  const width = Math.min(GUIDE_WIDTH, workArea.width - 24);
  const height = Math.min(contentHeight, workArea.height - 24);
  const right = settings
    ? settings.x + settings.width - 16
    : workArea.x + (workArea.width + width) / 2;
  const bottom = settings
    ? settings.y + settings.height - 16
    : workArea.y + workArea.height - 24;
  return {
    x: Math.round(
      Math.max(
        workArea.x + 12,
        Math.min(right - width, workArea.x + workArea.width - width - 12),
      ),
    ),
    y: Math.round(
      Math.max(
        workArea.y + 12,
        Math.min(bottom - height, workArea.y + workArea.height - height - 12),
      ),
    ),
    width,
    height,
  };
}
