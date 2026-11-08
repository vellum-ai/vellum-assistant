/**
 * One viewing session on the assistant desktop. The socket is opened here
 * rather than by noVNC because noVNC's `disconnect` event carries only
 * `{ clean }` and the close code is the runtime's only word on why a session
 * ended; the close listener is registered before noVNC attaches so the coded
 * reason wins.
 */

import RFB from "@novnc/novnc";

import { PairedVoiceUnavailableError } from "@/domains/chat/voice/live-voice/connection";
import { isIOSBrowser, isMacOSBrowser } from "@/runtime/platform-detection";

import {
  desktopEndReasonForClose,
  resolveDesktopStreamWsUrl,
  type DesktopEndReason,
} from "./desktop-connection";

/** Give up on a socket that has neither opened nor been refused by then. */
const CONNECT_TIMEOUT_MS = 15_000;
const CONTROL_KEYSYM = 0xffe3;
const V_KEYSYM = 0x76;

export type DesktopSessionState =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "ended"; reason: DesktopEndReason };

export type DesktopViewportMode = "fit" | "pan" | "control";

export interface OpenDesktopSessionArgs {
  assistantId: string;
  viewOnly?: boolean;
  viewportMode?: DesktopViewportMode;
  /** The element noVNC renders its canvas into. */
  container: HTMLElement;
  onState: (state: DesktopSessionState) => void;
}

export interface DesktopSession {
  /** End the session and release everything it holds. Idempotent. */
  close(): void;
  setViewOnly(viewOnly: boolean): void;
  setViewportMode(mode: DesktopViewportMode): void;
}

/**
 * Open a session against `assistantId`, reporting every state change through
 * `onState`. The caller owns the initial "connecting" state. Never reports
 * after `close()`.
 */
export function openDesktopSession({
  assistantId,
  container,
  onState,
  viewOnly = false,
  viewportMode = "fit",
}: OpenDesktopSessionArgs): DesktopSession {
  let done = false;
  let ws: WebSocket | null = null;
  let rfb: RFB | null = null;
  let currentViewOnly = viewOnly;
  let currentViewportMode = viewportMode;
  const commandIsControl = isMacOSBrowser() || isIOSBrowser();
  let controlHeld = false;
  let commandHeld = false;
  const releaseClipboardKeys = (): void => {
    if (commandHeld) {
      rfb?.sendKey(CONTROL_KEYSYM, "ControlLeft", false);
    }
    commandHeld = false;
    controlHeld = false;
  };
  const updateViewport = (): void => {
    if (rfb) {
      const mode = currentViewOnly ? "fit" : currentViewportMode;
      rfb.scaleViewport = mode === "fit";
      rfb.clipViewport = mode !== "fit";
      rfb.dragViewport = mode === "pan";
    }
  };
  const updateViewOnly = (): void => {
    if (rfb) {
      if (currentViewOnly) {
        releaseClipboardKeys();
      }
      rfb.viewOnly = currentViewOnly;
      rfb.focusOnClick = !currentViewOnly;
      updateViewport();
    }
  };
  const teardown: (() => void)[] = [];

  const release = (): void => {
    for (const fn of teardown.splice(0)) {
      fn();
    }
    if (rfb) {
      rfb.disconnect();
      rfb = null;
    } else if (
      ws &&
      (ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN)
    ) {
      ws.close(1000);
    }
  };

  const end = (reason: DesktopEndReason): void => {
    if (done) {
      return;
    }
    done = true;
    release();
    onState({ kind: "ended", reason });
  };

  const attach = (url: string): void => {
    let client: RFB;
    try {
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("close", (event) => {
        end(desktopEndReasonForClose(event.code));
      });
      client = new RFB(container, ws);
    } catch (err) {
      console.warn("desktop-session: could not attach to the desktop", err);
      end("failed");
      return;
    }
    rfb = client;
    client.background = "transparent";
    client.resizeSession = false;
    updateViewOnly();

    const connectTimer = setTimeout(() => end("lost"), CONNECT_TIMEOUT_MS);
    teardown.push(() => clearTimeout(connectTimer));

    client.addEventListener("connect", () => {
      clearTimeout(connectTimer);
      if (!done) {
        onState({ kind: "connected" });
      }
    });
    client.addEventListener("securityfailure", () => end("failed"));
    client.addEventListener("disconnect", () => end("lost"));

    // Remote copy: the pod's clipboard lands in the browser's. A write can be
    // refused when the document is not focused; the copy is simply not
    // mirrored then, and there is nothing to report.
    client.addEventListener("clipboard", (event) => {
      if (done || currentViewOnly) {
        return;
      }
      void navigator.clipboard?.writeText(event.detail.text).catch(() => {});
    });

    // Local copy: text copied in this window is offered to the pod's
    // clipboard. Only an explicit copy gesture reaches the pod; the clipboard
    // is never read on its own, since anything copied elsewhere is readable
    // by the assistant once it lands there.
    const onCopy = (): void => {
      const text = document.getSelection()?.toString();
      if (text && !currentViewOnly) {
        client.clipboardPasteFrom(text);
      }
    };
    window.addEventListener("copy", onCopy);
    teardown.push(() => window.removeEventListener("copy", onCopy));

    const onKey = (event: KeyboardEvent): void => {
      if (done || currentViewOnly) {
        return;
      }
      controlHeld = event.ctrlKey || (commandIsControl && event.metaKey);
      if (commandIsControl && event.key === "Meta") {
        // The remote Linux desktop uses Control for Command shortcuts.
        commandHeld = event.metaKey;
        event.stopPropagation();
        client.sendKey(CONTROL_KEYSYM, "ControlLeft", controlHeld);
      } else if (
        controlHeld &&
        (!commandIsControl || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "v"
      ) {
        // Keep the browser's paste event; noVNC prevents it by default.
        event.stopPropagation();
      }
    };
    const onPaste = (event: ClipboardEvent): void => {
      if (done || currentViewOnly) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!event.clipboardData?.types.includes("text/plain")) {
        return;
      }
      client.clipboardPasteFrom(event.clipboardData.getData("text/plain"));
      if (!controlHeld) {
        client.sendKey(CONTROL_KEYSYM, "ControlLeft", true);
      }
      client.sendKey(V_KEYSYM, "KeyV");
      if (!controlHeld) {
        client.sendKey(CONTROL_KEYSYM, "ControlLeft", false);
      }
    };
    container.addEventListener("keydown", onKey, true);
    container.addEventListener("keyup", onKey, true);
    container.addEventListener("paste", onPaste);
    container.addEventListener("blur", releaseClipboardKeys, true);
    window.addEventListener("blur", releaseClipboardKeys);
    teardown.push(() => {
      releaseClipboardKeys();
      container.removeEventListener("keydown", onKey, true);
      container.removeEventListener("keyup", onKey, true);
      container.removeEventListener("paste", onPaste);
      container.removeEventListener("blur", releaseClipboardKeys, true);
      window.removeEventListener("blur", releaseClipboardKeys);
    });
  };

  void resolveDesktopStreamWsUrl(assistantId).then(
    (url) => {
      if (!done) {
        attach(url);
      }
    },
    (err: unknown) => {
      console.warn("desktop-session: no desktop transport", err);
      end(
        err instanceof PairedVoiceUnavailableError ? "unavailable" : "failed",
      );
    },
  );

  return {
    setViewportMode: (value) => {
      currentViewportMode = value;
      updateViewport();
    },
    setViewOnly: (value) => {
      currentViewOnly = value;
      updateViewOnly();
    },
    close: () => {
      if (done) {
        return;
      }
      done = true;
      release();
    },
  };
}
