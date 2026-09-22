import { stat } from "node:fs/promises";
import path from "node:path";

import {
  app,
  BrowserWindow,
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
  isDraggablePermission,
  PERMISSION_SETUP_OPEN,
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
import {
  createFloatingWindow,
  getFloatingWindow,
} from "@vellumai/electron-desktop/floating-window";

import { defaultCaptureSourceDeps } from "./companion-capture-sources";
import { handle, on } from "./ipc";
import log from "./logger";
import {
  GUIDE_HEIGHT,
  GUIDE_WIDTH,
  permissionAppPath,
  permissionGuideBounds,
} from "./permission-drag-target";
import {
  openPermissionSettingsPane,
  type PermissionsService,
} from "./permissions-service";
import { getMacHelperAppPath } from "./sidecar/mac-helper-path";

const SETUP = "permission-setup";
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
  window: BrowserWindow;
  workArea: Rectangle;
  timers: ReturnType<typeof setInterval>[];
  ready: boolean;
  height: number;
  startedAt: number;
}

let guide: GuideSession | null = null;
let generation = 0;

function publishGuide(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PERMISSION_GUIDE_STATE, guide?.state ?? null);
    }
  }
}

function dismissGuide(): void {
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
}

export function openPermissionSetup(): void {
  const { workArea } = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint(),
  );
  const win = createFloatingWindow({
    kind: SETUP,
    route: "/floating/permission-setup",
    width: Math.min(660, workArea.width - 32),
    height: Math.min(780, workArea.height - 32),
    focusOnShow: true,
    callerShows: true,
    visibleOnAllWorkspaces: false,
    browserWindow: {
      hasShadow: true,
      movable: true,
      backgroundColor: "#00000000",
    },
  });
  win.setAlwaysOnTop(false);
  if (!win.isVisible()) {
    win.center();
    win.once("ready-to-show", () => win.show());
  }
}

function guideSender(id: number, sender: WebContents): GuideSession | null {
  return guide?.state.id === id && guide.window.webContents === sender
    ? guide
    : null;
}

async function followSettings(session: GuideSession): Promise<void> {
  const windows = await defaultCaptureSourceDeps.listWindows();
  if (guide !== session || !session.ready) {
    return;
  }
  const settings = windows.find(
    (win) => win.bundleId === "com.apple.systempreferences",
  );
  if (!settings) {
    return;
  }
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

async function beginGuide(
  service: PermissionsService,
  kind: DraggablePermissionKind,
  sender?: WebContents,
  source?: PermissionSourceRect,
): Promise<boolean> {
  dismissGuide();
  const id = generation;
  const state = await service.state(sender);
  if (id !== generation) {
    return true;
  }
  if (state[kind].status === "granted" || state[kind].status === "restricted") {
    return false;
  }
  const file = permissionAppPath(
    kind,
    app.getPath("exe"),
    getMacHelperAppPath(),
  );
  // Resolve only app-owned paths in main; a renderer cannot choose a drag payload.
  const [fileStat, icon] = await Promise.all([
    stat(file),
    app.getFileIcon(file, { size: "large" }),
  ]);
  if (!fileStat.isDirectory() || !file.endsWith(".app") || icon.isEmpty()) {
    throw new Error(
      "The permission app is unavailable. Reinstall Vellum and try again.",
    );
  }
  if (id !== generation) {
    return true;
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
    window: win,
    workArea,
    timers: [],
    ready: false,
    height: GUIDE_HEIGHT,
    startedAt: Date.now(),
  };
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
    return true;
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
            getFloatingWindow(SETUP)?.showInactive();
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
      if (positioning || !session.ready) {
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
  return true;
}

export function installPermissionSetup(service: PermissionsService): void {
  service.setSettingsPresenter(async (kind, sender) => {
    if (!isDraggablePermission(kind)) {
      return false;
    }
    try {
      return await beginGuide(service, kind, sender);
    } catch (error) {
      log.warn("[permissions] guide unavailable:", error);
      return false;
    }
  });
  handle(PERMISSION_SETUP_OPEN, z.tuple([]), () => openPermissionSetup());
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
      if (!session || (session.ready && session.height === height)) {
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
      dismissGuide();
      getFloatingWindow(SETUP)?.show();
    }
  });
  on(PERMISSION_GUIDE_DRAG, z.tuple([idSchema]), ([id], event) => {
    const session = guideSender(id, event.sender);
    if (!session) {
      return;
    }
    try {
      event.sender.startDrag({
        file: session.file,
        icon: session.icon.resize({ width: 64, height: 64 }),
      });
    } catch (error) {
      log.warn("[permissions] native drag failed:", error);
      session.state = { ...session.state, error: true };
      publishGuide();
    }
  });
  handle(PERMISSION_GUIDE_REVEAL, z.tuple([idSchema]), ([id], event) => {
    const session = guideSender(id, event.sender);
    if (session) {
      shell.showItemInFolder(session.file);
    }
  });
  app.on("before-quit", dismissGuide);
}
