/** Optional macOS setup bridge. Older shells retain their existing permission UI. */
import type {
  DraggablePermissionKind,
  PermissionGuideState,
  PermissionSourceRect,
  SystemPermissionStateItem,
} from "@vellumai/ipc-contract";

import { isElectron } from "@/runtime/is-electron";

const setup = () =>
  isElectron() ? window.vellum?.permissions?.setup : undefined;

export const supportsPermissionSetup = (): boolean => setup() !== undefined;
export const cancelPermissionGuide = (): void => {
  setup()?.cancel?.();
};
export const beginPermissionGuide = async (
  kind: DraggablePermissionKind,
  source?: PermissionSourceRect,
): Promise<SystemPermissionStateItem | null> => {
  return (await setup()?.begin(kind, source)) ?? null;
};
export const getPermissionGuide =
  async (): Promise<PermissionGuideState | null> =>
    (await setup()?.getGuide()) ?? null;
export const subscribePermissionGuide = (
  callback: (state: PermissionGuideState | null) => void,
): (() => void) => setup()?.onGuide(callback) ?? (() => undefined);
export const permissionGuideReady = (id: number, height: number): void => {
  setup()?.ready(id, height);
};
export const dismissPermissionGuide = (id: number): void => {
  setup()?.dismiss(id);
};
export const dragPermissionApp = (id: number): void => {
  setup()?.startDrag(id);
};
export const revealPermissionApp = async (id: number): Promise<void> => {
  await setup()?.revealApp(id);
};
