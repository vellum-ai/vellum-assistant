import { stat } from "node:fs/promises";
import path from "node:path";

import {
  app,
  BrowserWindow,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  type NativeImage,
  type Rectangle,
  type WebContents,
} from "electron";
import { z } from "zod";
import {
  DRAGGABLE_PERMISSION_KINDS,
  PERMISSION_GUIDE_MAX_HEIGHT,
  PERMISSION_GUIDE_CANCEL,
  PERMISSION_SETUP_BEGIN,
  PERMISSION_GUIDE_GET,
  PERMISSION_GUIDE_STATE,
  PERMISSION_GUIDE_READY,
  PERMISSION_GUIDE_DISMISS,
  PERMISSION_GUIDE_DRAG,
  PERMISSION_GUIDE_REVEAL,
  type DraggablePermissionKind,
  type PermissionGuideState,
  type PermissionSourceRect,
} from "@vellumai/ipc-contract";
import { createFloatingWindow } from "@vellumai/electron-desktop/floating-window";
import {
  getAccentHex,
  getAvatarPng,
  onAvatarChange,
} from "@vellumai/electron-desktop/avatar";

import { defaultCaptureSourceDeps } from "./companion-capture-sources";
import { handle, on } from "./ipc";
import log from "./logger";
import {
  GUIDE_HEIGHT,
  GUIDE_WIDTH,
  permissionGuideBounds,
} from "./permission-drag-target";
import {
  openPermissionSettingsPane,
  preparePermissionPresentation,
  type PermissionsService,
} from "./permissions-service";
import { getMacHelperAppPath } from "./sidecar/mac-helper-path";

const GUIDE = "permission-guide";
const kindSchema = z.enum(DRAGGABLE_PERMISSION_KINDS);
const idSchema = z.number().int().positive();
const sourceSchema = z.object({
  x: z.number().finite().min(0).max(10_000),
  y: z.number().finite().min(0).max(10_000),
  width: z.number().finite().min(1).max(2_000),
  height: z.number().finite().min(1).max(2_000),
});

interface GuideSession {
  state: PermissionGuideState;
  file: string;
  icon: NativeImage;
  bundleIcon: NativeImage;
  window: BrowserWindow;
  workArea: Rectangle;
  timers: ReturnType<typeof setInterval>[];
  ready: boolean;
  yieldedToSettings: boolean;
  settingsWindowId?: number;
  height: number;
  startedAt: number;
}

let guide: GuideSession | null = null;
let generation = 0;
let guideOwner: WebContents | undefined;

function refreshGuideAppearance(session: GuideSession): void {
  const png = getAvatarPng();
  const avatar = png ? nativeImage.createFromBuffer(png) : null;
  session.icon = avatar && !avatar.isEmpty() ? avatar : session.bundleIcon;
  session.state = {
    ...session.state,
    appIcon: session.icon.toDataURL(),
    accentHex: getAccentHex() ?? undefined,
  };
}

function publishGuide(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PERMISSION_GUIDE_STATE, guide?.state ?? null);
    }
  }
}

function dismissGuide(returnToOwner = false): void {
  const owner =
    returnToOwner && guideOwner && !guideOwner.isDestroyed()
      ? BrowserWindow.fromWebContents(guideOwner)
      : null;
  guideOwner = undefined;
  generation += 1;
  const previous = guide;
  guide = null;
  for (const timer of previous?.timers ?? []) {
    clearInterval(timer);
  }
  if (previous && !previous.window.isDestroyed()) {
    previous.window.destroy();
  }
  publishGuide();
  if (owner && !owner.isDestroyed()) {
    owner.show();
  }
}

function guideSender(id: number, sender: WebContents): GuideSession | null {
  return guide?.state.id === id && guide.window.webContents === sender
    ? guide
    : null;
}

async function followSettings(session: GuideSession): Promise<void> {
  const windows = await defaultCaptureSourceDeps.listWindows();
  if (guide !== session || !session.ready || session.yieldedToSettings) {
    return;
  }
  const settingsWindows = windows.filter(
    (win) => win.bundleId === "com.apple.systempreferences",
  );
  // Authentication dialogs can precede the main window in the window list.
  const settings =
    session.settingsWindowId === undefined
      ? settingsWindows.sort(
          (a, b) =>
            b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height,
        )[0]
      : settingsWindows.find(
          (win) => win.windowId === session.settingsWindowId,
        );
  if (!settings) {
    return;
  }
  session.settingsWindowId = settings.windowId;
  session.workArea = screen.getDisplayMatching(settings.bounds).workArea;
  const next = permissionGuideBounds(
    session.workArea,
    settings.bounds,
    session.height,
  );
  const current = session.window.getBounds();
  if (
    Object.keys(next).some(
      (key) => next[key as keyof Rectangle] !== current[key as keyof Rectangle],
    )
  ) {
    session.window.setBounds(
      next,
      !systemPreferences.getAnimationSettings().prefersReducedMotion,
    );
  }
}

function yieldToSettings(session: GuideSession): void {
  preparePermissionPresentation();
  session.yieldedToSettings = true;
  session.window.setAlwaysOnTop(false);
}

async function beginGuide(
  service: PermissionsService,
  kind: DraggablePermissionKind,
  sender?: WebContents,
  source?: PermissionSourceRect,
): Promise<void> {
  dismissGuide();
  const id = generation;
  guideOwner = sender;
  const state = await service.state(sender);
  if (id !== generation) {
    return;
  }
  if (state[kind].status === "granted" || state[kind].status === "restricted") {
    guideOwner = undefined;
    return;
  }
  const file = getMacHelperAppPath();
  // Resolve only app-owned paths in main; a renderer cannot choose a drag payload.
  const [fileStat, icon] = await Promise.all([
    stat(file),
    app.getFileIcon(file, { size: "normal" }),
  ]);
  if (!fileStat.isDirectory() || !file.endsWith(".app") || icon.isEmpty()) {
    throw new Error(
      "The permission app is unavailable. Reinstall Vellum and try again.",
    );
  }
  if (id !== generation) {
    return;
  }
  const owner = sender ? BrowserWindow.fromWebContents(sender) : null;
  const ownerBounds = owner?.getBounds();
  const workArea = ownerBounds
    ? screen.getDisplayMatching(ownerBounds).workArea
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const initial =
    ownerBounds && source
      ? {
          x: Math.round(ownerBounds.x + source.x),
          y: Math.round(ownerBounds.y + source.y),
          width: Math.round(source.width),
          height: Math.round(source.height),
        }
      : permissionGuideBounds(workArea);
  const win = createFloatingWindow({
    kind: GUIDE,
    route: "/floating/permission-guide",
    width: GUIDE_WIDTH,
    height: GUIDE_HEIGHT,
    callerShows: true,
    visibleOnAllWorkspaces: false,
    browserWindow: {
      hasShadow: true,
      movable: true,
      minimizable: false,
      maximizable: false,
    },
  });
  win.setBounds(initial);
  const session: GuideSession = {
    state: {
      id,
      kind,
      appName: path.basename(file, ".app"),
      appIcon: icon.toDataURL(),
      error: false,
    },
    file,
    icon,
    bundleIcon: icon,
    window: win,
    workArea,
    timers: [],
    ready: false,
    yieldedToSettings: false,
    height: GUIDE_HEIGHT,
    startedAt: Date.now(),
  };
  refreshGuideAppearance(session);
  guide = session;
  win.on("closed", () => {
    if (guide === session) {
      dismissGuide();
    }
  });
  publishGuide();
  try {
    await openPermissionSettingsPane(kind);
  } catch (error) {
    if (guide === session) {
      dismissGuide();
    }
    throw error;
  }
  if (guide !== session) {
    return;
  }
  let checking = false;
  session.timers.push(
    setInterval(() => {
      if (Date.now() - session.startedAt > 5 * 60_000) {
        dismissGuide();
        return;
      }
      if (checking) {
        return;
      }
      checking = true;
      void service
        .refresh()
        .then((next) => {
          if (guide === session && next[kind].status === "granted") {
            dismissGuide();
          }
        })
        .catch((error: unknown) =>
          log.warn("[permissions] refresh failed:", error),
        )
        .finally(() => {
          checking = false;
        });
    }, 2_000),
  );
  let positioning = false;
  session.timers.push(
    setInterval(() => {
      if (positioning || !session.ready || session.yieldedToSettings) {
        return;
      }
      positioning = true;
      void followSettings(session)
        .catch(() => undefined)
        .finally(() => {
          positioning = false;
        });
    }, 500),
  );
}

export function installCompanionPermissionGuide(
  service: PermissionsService,
): void {
  onAvatarChange(() => {
    if (guide) {
      refreshGuideAppearance(guide);
      publishGuide();
    }
  });
  on(PERMISSION_GUIDE_CANCEL, z.tuple([]), (_args, event) => {
    if (guideOwner === event.sender) {
      dismissGuide();
    }
  });
  handle(
    PERMISSION_SETUP_BEGIN,
    z.tuple([kindSchema, sourceSchema.optional()]),
    async ([kind, source], event) => {
      await beginGuide(service, kind, event.sender, source);
      return (await service.refresh(event.sender))[kind];
    },
  );
  handle(PERMISSION_GUIDE_GET, z.tuple([]), () => guide?.state ?? null);
  on(
    PERMISSION_GUIDE_READY,
    z.tuple([
      idSchema,
      z.number().int().min(GUIDE_HEIGHT).max(PERMISSION_GUIDE_MAX_HEIGHT),
    ]),
    ([id, height], event) => {
      const session = guideSender(id, event.sender);
      if (
        !session ||
        session.yieldedToSettings ||
        (session.ready && session.height === height)
      ) {
        return;
      }
      session.ready = true;
      session.height = height;
      session.window.showInactive();
      session.window.setBounds(
        permissionGuideBounds(session.workArea, undefined, session.height),
        !systemPreferences.getAnimationSettings().prefersReducedMotion,
      );
      void followSettings(session).catch(() => undefined);
    },
  );
  on(PERMISSION_GUIDE_DISMISS, z.tuple([idSchema]), ([id], event) => {
    if (guideSender(id, event.sender)) {
      dismissGuide(true);
    }
  });
  on(PERMISSION_GUIDE_DRAG, z.tuple([idSchema]), ([id], event) => {
    const session = guideSender(id, event.sender);
    if (!session) {
      return;
    }
    try {
      // The native drop can open authentication before startDrag returns.
      yieldToSettings(session);
      event.sender.startDrag({
        file: session.file,
        icon: session.icon.resize({ width: 64, height: 64 }),
      });
    } catch (error) {
      log.warn("[permissions] native drag failed:", error);
      if (guide !== session) {
        return;
      }
      session.yieldedToSettings = false;
      session.window.setAlwaysOnTop(true, "floating");
      session.state = { ...session.state, error: true };
      publishGuide();
    }
  });
  handle(PERMISSION_GUIDE_REVEAL, z.tuple([idSchema]), ([id], event) => {
    const session = guideSender(id, event.sender);
    if (session) {
      yieldToSettings(session);
      shell.showItemInFolder(session.file);
    }
  });
  app.on("before-quit", () => dismissGuide());
}
