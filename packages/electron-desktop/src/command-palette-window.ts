import { BrowserWindow, screen } from "electron";
import { z } from "zod";

import {
  COMMAND_PALETTE_DISMISS,
  COMMAND_PALETTE_OPEN,
  COMMAND_PALETTE_SELECT,
  type VellumCommand,
} from "@vellumai/ipc-contract";

import {
  createFloatingWindow,
  getFloatingWindow,
  repositionFloatingWindow,
} from "./floating-window";
import type { IpcHandle } from "./ipc";
import { createModuleConfiguration } from "./module-configuration";

const COMMAND_PALETTE_KIND = "commandPalette";
const COMMAND_PALETTE_PATH = "/floating/command-palette";

const PANEL_WIDTH = 584;
const PANEL_HEIGHT = 444;

export interface CommandPaletteWindowDependencies {
  currentMainWindow: () => BrowserWindow | null;
  dispatchToMain: (command: VellumCommand) => void;
  ensureMainWindowVisible: () => void | Promise<void>;
  handle: IpcHandle;
}

const configuration = createModuleConfiguration<CommandPaletteWindowDependencies>(
  "Command palette window module",
);
export const configureCommandPaletteWindow = configuration.configure;

type PayloadCommandKind = Extract<
  VellumCommand,
  { kind: "selectAssistant" | "retireAssistant" | "quickInputSubmit" }
>["kind"];

// Kinds the palette never dispatches. This list and the zod schema below
// grow together: a new VellumCommand kind either gets a schema member or
// joins this exclusion, otherwise palette code can type-check a dispatch
// that main rejects at runtime.
type ExcludedCommandKind = "commandPalette" | "removePairedAssistant";

type CommandPaletteDispatchCommand =
  | Exclude<
      VellumCommand,
      { kind: ExcludedCommandKind } | { kind: PayloadCommandKind }
    >
  | Extract<VellumCommand, { kind: PayloadCommandKind }>;

const payloadlessCommandKindSchema = z.enum([
  "newConversation",
  "currentConversation",
  "markCurrentUnread",
  "togglePinConversation",
  "openSettings",
  "shareFeedback",
  "find",
  "markAllRead",
  "login",
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
  "openComponentGallery",
]);

// Exported for unit tests pinning the schema against the exclusion list.
export const commandPaletteDispatchCommandSchema: z.ZodType<CommandPaletteDispatchCommand> =
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

export const repositionCommandPaletteWindow = (): void => {
  repositionFloatingWindow(COMMAND_PALETTE_KIND, commandPalettePosition);
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
      focusable: true,
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

  const { currentMainWindow, dispatchToMain, ensureMainWindowVisible } =
    configuration.get();
  const main = currentMainWindow();
  if (!main || main.isDestroyed() || !main.isVisible() || main.isMinimized()) {
    await ensureMainWindowVisible();
  }

  dispatchToMain(command);
};

let installed = false;

export const installCommandPaletteWindow = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  const { handle } = configuration.get();

  handle(COMMAND_PALETTE_OPEN, z.tuple([]), () => {
    openCommandPaletteWindow();
  });

  handle(COMMAND_PALETTE_DISMISS, z.tuple([]), () => {
    closeCommandPaletteWindow();
  });

  handle(
    COMMAND_PALETTE_SELECT,
    z.tuple([commandPaletteDispatchCommandSchema]),
    async ([command]) => {
      await selectCommandPaletteCommand(command);
    },
  );
};

export const __resetForTesting = (): void => {
  installed = false;
};
