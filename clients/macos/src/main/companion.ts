import { systemPreferences } from "electron";
import { configureCompanionWindow } from "@vellumai/electron-desktop/companion-platform";
import {
  captureSourceThumbnail,
  captureTargetFrame,
  locateOnTarget,
  listCaptureSources,
  resolveCapturePick,
  windowBoundsFor,
} from "./companion-capture";
import {
  unwatchCoachmarkPress,
  watchCoachmarkPress,
} from "./coachmark-press-watch";
import { setPointerOnCompanion } from "./companion-pointer";
import { unwatchFrameScroll, watchFrameScroll } from "./frame-scroll-watch";
import { handle, on } from "./ipc";
import log from "./logger";
import {
  getPermissionsService,
  onPermissionPresentation,
} from "./permissions-service";
import {
  answerScreenRecordingRefusal,
  isScreenRecordingRefusal,
  screenRecordingGranted,
} from "./screen-recording-permission";
import {
  current as currentMainWindow,
  dispatchToMain,
  ensureVisible as ensureMainWindowVisible,
  onMainWindowVisibilityChange,
} from "./main-window";

configureCompanionWindow({
  prefersReducedMotion: () =>
    systemPreferences.getAnimationSettings().prefersReducedMotion,
  microphoneGranted: () =>
    systemPreferences.getMediaAccessStatus("microphone") === "granted",
  openScreenSettings: async () => {
    await getPermissionsService()?.openSettings("screen");
  },
  captureSourceThumbnail,
  captureTargetFrame,
  locateOnTarget,
  listCaptureSources,
  resolveCapturePick,
  windowBoundsFor,
  unwatchCoachmarkPress,
  watchCoachmarkPress,
  setPointerOnCompanion,
  unwatchFrameScroll,
  watchFrameScroll,
  handle,
  on,
  onPermissionPresentation,
  answerScreenRecordingRefusal,
  isScreenRecordingRefusal,
  screenRecordingGranted,
  currentMainWindow,
  dispatchToMain,
  ensureMainWindowVisible,
  onMainWindowVisibilityChange,
  log,
});

export * from "@vellumai/electron-desktop/companion-window";
