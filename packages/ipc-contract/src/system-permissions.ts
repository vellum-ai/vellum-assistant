import type { DraggablePermissionKind, SystemPermissionKind } from "./types";

export const DRAGGABLE_PERMISSION_KINDS = [
  "accessibility",
  "screen",
  "inputMonitoring",
] as const;

/** Privacy panes that accept an application bundle dropped into their list. */
export const isDraggablePermission = (
  kind: SystemPermissionKind,
): kind is DraggablePermissionKind =>
  DRAGGABLE_PERMISSION_KINDS.some((candidate) => candidate === kind);

export const PERMISSION_GUIDE_MIN_HEIGHT = 148;
export const PERMISSION_GUIDE_MAX_HEIGHT = 320;
