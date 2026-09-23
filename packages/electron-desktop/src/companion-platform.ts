import type { BrowserWindow } from "electron";
import type { VellumCommand } from "@vellumai/ipc-contract";
import type * as capture from "./companion-capture-sources";
import type { IpcHandle, IpcOn } from "./ipc";
import { createModuleConfiguration } from "./module-configuration";

export interface CoachmarkPressRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompanionPlatform {
  handle: IpcHandle;
  on: IpcOn;
  log: Pick<Console, "warn" | "info" | "error">;
  currentMainWindow(): BrowserWindow | null;
  dispatchToMain(command: VellumCommand): void;
  ensureMainWindowVisible(): Promise<void>;
  onMainWindowVisibilityChange(listener: () => void): void;
  prefersReducedMotion(): boolean;
  microphoneGranted(): boolean;
  onPermissionPresentation(listener: () => void): void;
  openScreenSettings(): Promise<void>;
  screenRecordingGranted(): Promise<boolean>;
  isScreenRecordingRefusal?(error: unknown): boolean;
  answerScreenRecordingRefusal?(
    askForGrant: () => Promise<unknown>,
  ): Promise<void>;
  setPointerOnCompanion?(on: boolean): void;
  watchCoachmarkPress(
    rects: readonly CoachmarkPressRect[],
    listener: (index: number) => void,
  ): void;
  unwatchCoachmarkPress(): void;
  watchFrameScroll(listener: () => void): void;
  unwatchFrameScroll(): void;
  captureSourceThumbnail: typeof capture.captureSourceThumbnail;
  captureTargetFrame: typeof capture.captureTargetFrame;
  locateOnTarget: typeof capture.locateOnTarget;
  listCaptureSources: typeof capture.listCaptureSources;
  resolveCapturePick: typeof capture.resolveCapturePick;
  windowBoundsFor: typeof capture.windowBoundsFor;
}

const configuration =
  createModuleConfiguration<CompanionPlatform>("Companion window");
export const configureCompanionWindow = configuration.configure;
export const companionPlatform = configuration.get;
