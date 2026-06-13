import { BrowserWindow, screen } from "electron";
import { z } from "zod";

import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle } from "./ipc";
import {
  current as currentMainWindow,
  dispatchToMain,
  ensureVisible as ensureMainWindowVisible,
} from "./main-window";
import type { VellumCommand } from "./commands";

const COMMAND_PALETTE_KIND = "commandPalette";
const COMMAND_PALETTE_PATH = "/floating/command-palette";

const PANEL_WIDTH = 584;
const PANEL_HEIGHT = 444;

type PayloadCommandKind = Extract<
  VellumCommand,
  { kind: "selectAssistant" | "retireAssistant" | "quickInputSubmit" }
>["kind"];

type CommandPaletteDispatchCommand =
  | Exclude<
      VellumCommand,
      { kind: "commandPalette" } | { kind: PayloadCommandKind }
    >
  | Extract<VellumCommand, { kind: PayloadCommandKind }>;

const payloadlessCommandKindSchema = z.enum([
  "newConversation",
  "currentConversation",
  "markCurrentUnread",
  "openSettings",
  "shareFeedback",
  "find",
  "markAllRead",
  "logout",
  "rePair",
  "sidebarToggle",
  "home",
  "popOut",
  "previousConversation",
  "nextConversation",
  "openLibrary",
  "openIdentity",
  "navigateBack",
  "navigateForward",
  "zoomIn",
  "zoomOut",
  "actualSize",
  "createAssistant",
  "replayOnboarding",
  "previewPrechat",
  "openComponentGallery",
]);

const commandPaletteDispatchCommandSchema: z.ZodType<CommandPaletteDispatchCommand> =
  z.union([
    z.object({ kind: payloadlessCommandKindSchema }),
    z.object({ kind: z.literal("openConversation"), conversationId: z.string() }),
    z.object({ kind: z.literal("selectAssistant"), assistantId: z.string() }),
    z.object({ kind: z.literal("retireAssistant"), assistantId: z.string() }),
    z.object({ kind: z.literal("quickInputSubmit"), message: z.string() }),
  ]) as z.ZodType<CommandPaletteDispatchCommand>;

const focusedDisplayWorkArea = (): Electron.Rectangle => {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    return screen.getDisplayMatching(focused.getBounds()).workArea;
  }
  const cursor = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursor).workArea;
};

const commandPalettePosition = (): { x: number; y: number } => {
  const { x, y, width, height } = focusedDisplayWorkArea();
  return {
    x: Math.round(x + (width - PANEL_WIDTH) / 2),
    y: Math.round(y + (height - PANEL_HEIGHT) / 2),
  };
};

export const closeCommandPaletteWindow = (): void => {
  const win = getFloatingWindow(COMMAND_PALETTE_KIND);
  if (win && !win.isDestroyed()) {
    win.close();
  }
};

const wireCloseHandlers = (win: BrowserWindow): void => {
  win.on("blur", () => {
    closeCommandPaletteWindow();
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      closeCommandPaletteWindow();
    }
  });
};

export const openCommandPaletteWindow = (): void => {
  const existing = getFloatingWindow(COMMAND_PALETTE_KIND);
  const win = createFloatingWindow({
    kind: COMMAND_PALETTE_KIND,
    route: COMMAND_PALETTE_PATH,
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    focusOnShow: true,
    position: commandPalettePosition,
    browserWindow: {
      minimizable: false,
      maximizable: false,
      hasShadow: true,
      backgroundColor: "#00000000",
    },
  });

  if (!existing) {
    wireCloseHandlers(win);
  }
};

export const isCommandPaletteWindowFocused = (): boolean => {
  const focused = BrowserWindow.getFocusedWindow();
  const palette = getFloatingWindow(COMMAND_PALETTE_KIND);
  return Boolean(focused && palette && focused === palette);
};

export const selectCommandPaletteCommand = async (
  command: CommandPaletteDispatchCommand,
): Promise<void> => {
  closeCommandPaletteWindow();

  const main = currentMainWindow();
  if (!main || main.isDestroyed() || !main.isVisible() || main.isMinimized()) {
    await ensureMainWindowVisible();
  }

  dispatchToMain(command);
};

let installed = false;

export const installCommandPaletteWindow = (): void => {
  if (installed) return;
  installed = true;

  handle("vellum:commandPalette:open", z.tuple([]), () => {
    openCommandPaletteWindow();
  });

  handle("vellum:commandPalette:dismiss", z.tuple([]), () => {
    closeCommandPaletteWindow();
  });

  handle(
    "vellum:commandPalette:select",
    z.tuple([commandPaletteDispatchCommandSchema]),
    async ([command]) => {
      await selectCommandPaletteCommand(command);
    },
  );
};

export const __resetForTesting = (): void => {
  installed = false;
};
