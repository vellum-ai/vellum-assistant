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

const flushMicrotasks = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
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
    await flushMicrotasks();

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
    await flushMicrotasks();
    backButtonHandler?.({ canGoBack: true });

    expect(escapeHandler).toHaveBeenCalledTimes(1);
    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();

    document.removeEventListener("keydown", escapeHandler);
    historyBackSpy.mockRestore();
  });

  test("falls through when an open layer does not handle Escape", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);

    subscribeAndroidBackButtonSource();
    await flushMicrotasks();
    backButtonHandler?.({ canGoBack: true });

    expect(historyBackSpy).toHaveBeenCalledTimes(1);
    expect(minimizeAppMock).not.toHaveBeenCalled();
    historyBackSpy.mockRestore();
  });

  test("claims Back when the target layer closes on Escape", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    dialog.addEventListener("keydown", () => dialog.remove());

    subscribeAndroidBackButtonSource();
    await flushMicrotasks();
    backButtonHandler?.({ canGoBack: true });

    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();
    historyBackSpy.mockRestore();
  });

  test("navigates WebView history when no UI layer is open", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );

    subscribeAndroidBackButtonSource();
    await flushMicrotasks();
    backButtonHandler?.({ canGoBack: true });

    expect(historyBackSpy).toHaveBeenCalledTimes(1);
    expect(minimizeAppMock).not.toHaveBeenCalled();
    historyBackSpy.mockRestore();
  });

  test("closes a mobile viewer layer before changing history", async () => {
    const historyBackSpy = spyOn(window.history, "back").mockImplementation(
      () => undefined,
    );
    viewerMainView = "tool-detail";

    subscribeAndroidBackButtonSource();
    await flushMicrotasks();
    backButtonHandler?.({ canGoBack: true });

    expect(closeActiveOverlayMock).toHaveBeenCalledTimes(1);
    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(minimizeAppMock).not.toHaveBeenCalled();
    historyBackSpy.mockRestore();
  });

  test("minimizes an expanded app viewer before leaving it", async () => {
    viewerMainView = "app";

    subscribeAndroidBackButtonSource();
    await flushMicrotasks();
    backButtonHandler?.({ canGoBack: true });

    expect(minimizeViewerAppMock).toHaveBeenCalledTimes(1);
    expect(closeAppMock).not.toHaveBeenCalled();
  });

  test("minimizes the app at the WebView history root", async () => {
    subscribeAndroidBackButtonSource();
    await flushMicrotasks();

    backButtonHandler?.({ canGoBack: false });

    expect(minimizeAppMock).toHaveBeenCalledTimes(1);
  });

  test("removes the native listener on cleanup", async () => {
    const unsubscribe = subscribeAndroidBackButtonSource();
    await flushMicrotasks();

    unsubscribe();

    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});
