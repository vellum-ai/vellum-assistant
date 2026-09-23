import { app, screen, systemPreferences } from "electron";
import { z } from "zod";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { configureCompanionWindow } from "@vellumai/electron-desktop/companion-platform";
import {
  installCompanionWindow,
  syncCompanionSurface,
} from "@vellumai/electron-desktop/companion-window";
import {
  configureCompanionCapture,
  captureSourceThumbnail,
  captureTargetFrame,
  locateOnTarget,
  listCaptureSources,
  resolveCapturePick,
  windowBoundsFor,
} from "@vellumai/electron-desktop/companion-capture-sources";
import { getFloatingWindow } from "@vellumai/electron-desktop/floating-window";
import { createCompanionInput } from "../companion-input";
import { callCompanionCapture } from "../companion-capture";
import { handle, on } from "../ipc.client";
import log from "../logger";
import {
  current,
  dispatchToMain,
  ensureVisible,
  onMainWindowVisibilityChange,
} from "../main-window";
import {
  getWindowsPermissionsService,
  onPermissionPresentation,
} from "./permissions";

const feature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "companion",
  install: () => {
    configureCompanionCapture({
      call: callCompanionCapture,
      // Windows offers browser windows through the ordinary window picker.
      runChromeAppleScript: async () => "",
      log,
    });
    configureCompanionWindow({
      platform: "win32",
      handle,
      on,
      log,
      currentMainWindow: current,
      dispatchToMain,
      ensureMainWindowVisible: ensureVisible,
      onMainWindowVisibilityChange,
      prefersReducedMotion: () =>
        systemPreferences.getAnimationSettings().prefersReducedMotion,
      microphoneGranted: () =>
        systemPreferences.getMediaAccessStatus("microphone") === "granted",
      onPermissionPresentation,
      openScreenSettings: async () => {
        await getWindowsPermissionsService()?.openSettings("screen");
      },
      screenRecordingGranted: async () => {
        const state = await getWindowsPermissionsService()?.state();
        return (
          state?.screen.status !== "denied" &&
          state?.screen.status !== "restricted"
        );
      },
      ...createCompanionInput(),
      captureSourceThumbnail,
      captureTargetFrame,
      locateOnTarget,
      listCaptureSources,
      resolveCapturePick,
      windowBoundsFor,
    });
    installCompanionWindow();
    syncCompanionSurface();

    // Sample live layout through the renderer, including CSS expansion under a still cursor.
    let pointerSubscribed = false;
    on(
      "vellum:companion:watchPointer",
      z.tuple([z.boolean()]),
      ([enabled], event) => {
        if (event.sender === getFloatingWindow("companion")?.webContents) {
          pointerSubscribed = enabled;
        }
      },
    );
    const timer = setInterval(() => {
      const win = getFloatingWindow("companion");
      if (!pointerSubscribed || !win || !win.isVisible()) {
        return;
      }
      const point = screen.getCursorScreenPoint();
      const bounds = win.getBounds();
      const zoom = win.webContents.getZoomFactor();
      win.webContents.send("vellum:companion:pointer", {
        x: (point.x - bounds.x) / zoom,
        y: (point.y - bounds.y) / zoom,
      });
    }, 32);
    timer.unref();
    app.once("before-quit", () => clearInterval(timer));
  },
};
export default feature;
