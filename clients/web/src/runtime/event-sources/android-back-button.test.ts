import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

type BackButtonHandler = (payload: { canGoBack: boolean }) => void;

let nativeAndroid = true;
mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => nativeAndroid,
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => true,
}));

let viewerMainView = "chat";
let viewerAppMinimized = false;
const closeAppMock = mock(() => {});
const minimizeViewerAppMock = mock(() => {});
const exitAppEditingMock = mock(() => {});
const closeActiveOverlayMock = mock(() => viewerMainView === "tool-detail");
mock.module("@/stores/viewer-store", () => ({
  useViewerStore: {
    getState: () => ({
      mainView: viewerMainView,
      isAppMinimized: viewerAppMinimized,
      closeApp: closeAppMock,
      minimizeApp: minimizeViewerAppMock,
      exitAppEditing: exitAppEditingMock,
      closeActiveOverlay: closeActiveOverlayMock,
    }),
  },
}));

let backButtonHandler: BackButtonHandler | null = null;
const removeMock = mock(async () => {});
const addListenerMock = mock(
  (_event: "backButton", handler: BackButtonHandler) => {
    backButtonHandler = handler;
    return Promise.resolve({ remove: removeMock });
  },
);
const minimizeAppMock = mock(async () => {});

mock.module("@capacitor/app", () => ({
  App: {
    addListener: addListenerMock,
    minimizeApp: minimizeAppMock,
  },
}));

await import("@capacitor/app");

const { subscribeAndroidBackButtonSource } =
  await import("@/runtime/event-sources/android-back-button");

const flushAsyncWork = async (rounds = 4) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

const pressBack = async (canGoBack: boolean) => {
  backButtonHandler?.({ canGoBack });
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
  await flushAsyncWork();
};

const mountActiveChatView = () => {
  const marker = document.createElement("span");
  marker.dataset.slot = "active-chat-view";
  document.body.append(marker);
};

beforeEach(() => {
  nativeAndroid = true;
  viewerMainView = "chat";
  viewerAppMinimized = false;
  backButtonHandler = null;
  addListenerMock.mockClear();
  minimizeAppMock.mockClear();
  removeMock.mockClear();
  closeAppMock.mockClear();
  minimizeViewerAppMock.mockClear();
  exitAppEditingMock.mockClear();
  closeActiveOverlayMock.mockClear();
  document.body.replaceChildren();
});

describe("subscribeAndroidBackButtonSource", () => {
  test("does not subscribe outside the native Android shell", async () => {
    nativeAndroid = false;

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();

    expect(addListenerMock).not.toHaveBeenCalled();
  });

  test("offers Back to the topmost UI layer before changing history", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    const escapeHandler = mock((event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
      }
    });
    document.addEventListener("keydown", escapeHandler);

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();

    document.removeEventListener("keydown", escapeHandler);
    historyBackSpy.mockRestore();
  });

  test("closes a portaled dropdown before changing history", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const trigger = document.createElement("button");
    trigger.dataset.slot = "dropdown-trigger";
    trigger.setAttribute("aria-controls", "test-dropdown");
    const menu = document.createElement("ul");
    menu.id = "test-dropdown";
    menu.dataset.slot = "dropdown-menu";
    const escapeHandler = mock((event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        menu.remove();
      }
    });
    trigger.addEventListener("keydown", escapeHandler);
    document.body.append(trigger, menu);

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();
    historyBackSpy.mockRestore();
  });

  test("does not navigate behind a layer that blocks Escape", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();
    historyBackSpy.mockRestore();
  });

  test("offers Back to a global Escape surface without a dialog marker", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const escapeHandler = mock((event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
      }
    });
    window.addEventListener("keydown", escapeHandler);

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();

    window.removeEventListener("keydown", escapeHandler);
    historyBackSpy.mockRestore();
  });

  test("stops after a focused control handles Escape", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const input = document.createElement("input");
    const escapeHandler = mock((event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
      }
    });
    input.addEventListener("keydown", escapeHandler);
    document.body.append(input);
    input.focus();

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();

    historyBackSpy.mockRestore();
  });

  test("does not close a lower global surface behind a claimed layer", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.addEventListener("keydown", (event) => event.preventDefault());
    document.body.append(dialog);
    const lowerClose = mock(() => {});
    const lowerHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        lowerClose();
      }
    };
    window.addEventListener("keydown", lowerHandler);

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(lowerClose).not.toHaveBeenCalled();

    window.removeEventListener("keydown", lowerHandler);
  });

  test("closes a focused drawer above a later portaled voice sheet", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const drawer = document.createElement("div");
    drawer.setAttribute("role", "dialog");
    drawer.dataset.state = "open";
    const drawerButton = document.createElement("button");
    drawer.append(drawerButton);
    const voiceSheet = document.createElement("div");
    voiceSheet.dataset.slot = "bottom-sheet-content";
    voiceSheet.dataset.state = "open";
    voiceSheet.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
      }
    });
    document.body.append(drawer, voiceSheet);
    drawerButton.focus();

    const drawerHandler = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        drawer.contains(document.activeElement)
      ) {
        event.preventDefault();
        drawer.remove();
      }
    };
    document.addEventListener("keydown", drawerHandler);

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(drawer.isConnected).toBe(false);
    expect(voiceSheet.isConnected).toBe(true);
    expect(historyBackSpy).not.toHaveBeenCalled();

    document.removeEventListener("keydown", drawerHandler);
    historyBackSpy.mockRestore();
  });

  test("closes a focused control's dropdown before its dialog", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const trigger = document.createElement("button");
    trigger.dataset.slot = "dropdown-trigger";
    trigger.setAttribute("aria-controls", "nested-dropdown");
    dialog.append(trigger);
    const menu = document.createElement("div");
    menu.id = "nested-dropdown";
    menu.dataset.slot = "dropdown-menu";
    document.body.append(dialog, menu);
    trigger.focus();

    const closeDialog = mock(() => dialog.remove());
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeDialog();
      }
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        menu.remove();
      }
    });

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(menu.isConnected).toBe(false);
    expect(dialog.isConnected).toBe(true);
    expect(closeDialog).not.toHaveBeenCalled();
  });

  test("closes an active process overlay before changing history", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const panel = document.createElement("div");
    panel.dataset.slot = "active-overlay-panel";
    panel.dataset.state = "open";
    document.body.append(panel);
    const escapeHandler = mock((event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        panel.remove();
      }
    });
    document.addEventListener("keydown", escapeHandler);

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(historyBackSpy).not.toHaveBeenCalled();
    document.removeEventListener("keydown", escapeHandler);
    historyBackSpy.mockRestore();
  });

  test("waits for a target layer's close state to commit", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.append(dialog);
    dialog.addEventListener("keydown", () => {
      window.requestAnimationFrame(() => {
        dialog.setAttribute("data-state", "closed");
      });
    });

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();
    historyBackSpy.mockRestore();
  });

  test("navigates WebView history when no UI layer is open", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(historyBackSpy).toHaveBeenCalledTimes(1);
    expect(minimizeAppMock).not.toHaveBeenCalled();
    historyBackSpy.mockRestore();
  });

  test("closes a mobile viewer layer before changing history", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    viewerMainView = "tool-detail";
    mountActiveChatView();

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(closeActiveOverlayMock).toHaveBeenCalledTimes(1);
    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();
    historyBackSpy.mockRestore();
  });

  test("minimizes an expanded app viewer before leaving it", async () => {
    viewerMainView = "app";
    mountActiveChatView();

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(minimizeViewerAppMock).toHaveBeenCalledTimes(1);
    expect(closeAppMock).not.toHaveBeenCalled();
  });

  test("ignores stale viewer state outside the active chat route", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    viewerMainView = "app";

    subscribeAndroidBackButtonSource();
    await flushAsyncWork();
    await pressBack(true);

    expect(minimizeViewerAppMock).not.toHaveBeenCalled();
    expect(historyBackSpy).toHaveBeenCalledTimes(1);
    historyBackSpy.mockRestore();
  });

  test("minimizes the app at the WebView history root", async () => {
    subscribeAndroidBackButtonSource();
    await flushAsyncWork();

    await pressBack(false);

    expect(minimizeAppMock).toHaveBeenCalledTimes(1);
  });

  test("removes the native listener on cleanup", async () => {
    const unsubscribe = subscribeAndroidBackButtonSource();
    await flushAsyncWork();

    unsubscribe();

    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});
