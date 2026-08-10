import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

import { createModuleConfiguration } from "./module-configuration";
import type { CreateWindowOptions } from "./windows";

type AlwaysOnTopLevel = NonNullable<
  Parameters<BrowserWindow["setAlwaysOnTop"]>[1]
>;
type IgnoreMouseEventsOptions = NonNullable<
  Parameters<BrowserWindow["setIgnoreMouseEvents"]>[1]
>;

export type FloatingWindowPosition =
  | { x: number; y: number }
  | ((win: BrowserWindow) => { x: number; y: number });

export interface CreateFloatingWindowOptions {
  kind: string;
  route: string;
  width: number;
  height: number;
  focusOnShow?: boolean;
  alwaysOnTopLevel?: AlwaysOnTopLevel;
  visibleOnAllWorkspaces?: boolean;
  ignoreMouseEvents?: boolean | IgnoreMouseEventsOptions;
  browserWindow?: Omit<
    BrowserWindowConstructorOptions,
    | "webPreferences"
    | "type"
    | "width"
    | "height"
    | "frame"
    | "transparent"
    | "resizable"
    | "skipTaskbar"
    | "fullscreenable"
    | "show"
  >;
  position?: FloatingWindowPosition;
}

export interface FloatingWindowDependencies {
  createWindow: (options: CreateWindowOptions) => BrowserWindow;
  platform: "darwin" | "win32";
  resolveRoute: (route: string) => string;
}

export const createWindowRouteResolver = (getBase: () => string) =>
  (route: string): string =>
    `${getBase()}${route.startsWith("/") ? route : `/${route}`}`;

const configuration = createModuleConfiguration<FloatingWindowDependencies>(
  "Floating window module",
);
export const configureFloatingWindows = configuration.configure;

const floatingWindows = new Map<string, BrowserWindow>();

const isAlive = (win: BrowserWindow): boolean =>
  !win.isDestroyed() && !win.webContents.isDestroyed();

export const getFloatingWindow = (kind: string): BrowserWindow | null => {
  const win = floatingWindows.get(kind);
  if (!win) {
    return null;
  }
  if (isAlive(win)) {
    return win;
  }
  floatingWindows.delete(kind);
  return null;
};

const applyPosition = (
  win: BrowserWindow,
  position: FloatingWindowPosition | undefined,
): void => {
  if (!position) {
    return;
  }
  const { x, y } = typeof position === "function" ? position(win) : position;
  win.setPosition(x, y);
};

export const repositionFloatingWindow = (
  kind: string,
  position: FloatingWindowPosition,
): void => {
  const win = getFloatingWindow(kind);
  if (win) {
    applyPosition(win, position);
  }
};

const showFloatingWindow = (
  win: BrowserWindow,
  focusOnShow: boolean,
): void => {
  if (focusOnShow) {
    win.show();
    win.focus();
    return;
  }
  win.showInactive();
};

const applyIgnoreMouseEvents = (
  win: BrowserWindow,
  ignoreMouseEvents: boolean | IgnoreMouseEventsOptions,
): void => {
  if (typeof ignoreMouseEvents === "boolean") {
    win.setIgnoreMouseEvents(true);
  } else {
    win.setIgnoreMouseEvents(true, ignoreMouseEvents);
  }
};

export const createFloatingWindow = ({
  kind,
  route,
  width,
  height,
  focusOnShow = false,
  alwaysOnTopLevel = "floating",
  visibleOnAllWorkspaces = true,
  ignoreMouseEvents = false,
  browserWindow,
  position,
}: CreateFloatingWindowOptions): BrowserWindow => {
  const { createWindow, platform, resolveRoute } = configuration.get();
  const existing = getFloatingWindow(kind);
  if (existing) {
    applyPosition(existing, position);
    if (ignoreMouseEvents) {
      applyIgnoreMouseEvents(existing, ignoreMouseEvents);
    }
    showFloatingWindow(existing, focusOnShow);
    return existing;
  }

  const win = createWindow({
    browserWindow: {
      ...browserWindow,
      ...(platform === "darwin" ? { type: "panel" as const } : {}),
      width,
      height,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
    },
    navigation: "deny-all",
  });

  win.setAlwaysOnTop(true, alwaysOnTopLevel);
  if (ignoreMouseEvents) {
    applyIgnoreMouseEvents(win, ignoreMouseEvents);
  }
  if (visibleOnAllWorkspaces && platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }

  const cleanup = (): void => {
    if (floatingWindows.get(kind) === win) {
      floatingWindows.delete(kind);
    }
  };
  win.on("closed", cleanup);
  win.webContents.on("destroyed", cleanup);

  floatingWindows.set(kind, win);
  applyPosition(win, position);
  void win.loadURL(resolveRoute(route));
  showFloatingWindow(win, focusOnShow);
  return win;
};
