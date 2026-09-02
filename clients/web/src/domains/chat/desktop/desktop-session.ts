/**
 * One viewing session on the pod desktop: the socket, the noVNC client on
 * top of it, and the clipboard bridge between the two machines.
 *
 * **The socket is opened here, not by noVNC.** noVNC accepts a WebSocket-like
 * object in place of a URL, and that is what lets this module see the close
 * code: its own `disconnect` event carries only `{ clean }`, and the close
 * code is the runtime's only word on why a session ended (busy, unavailable,
 * failed). The close listener is registered before noVNC attaches, so it
 * runs first and the reason it reads wins over the generic `disconnect`.
 *
 * **Resize is the protocol's, not ours.** `resizeSession` makes noVNC send
 * RFB `SetDesktopSize` whenever the container changes size, which the pod's
 * X server honors natively. No control channel exists for it.
 *
 * Framework-agnostic on purpose: the panel is a thin React wrapper, and the
 * seams in {@link DesktopSessionOptions} let a test drive every ending
 * without a socket or a display.
 */

import RFB from "@novnc/novnc";

import {
  desktopEndReasonForClose,
  desktopEndReasonForResolveError,
  resolveDesktopStreamWsUrl,
  type DesktopEndReason,
} from "./desktop-connection";

export type DesktopSessionState =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "ended"; reason: DesktopEndReason };

/** Injection seams for tests. */
export interface DesktopSessionOptions {
  webSocketFactory?: (url: string) => WebSocket;
  /** Resolves the socket URL. Defaults to {@link resolveDesktopStreamWsUrl}. */
  resolveWsUrl?: (assistantId: string) => Promise<string>;
}

export interface OpenDesktopSessionArgs {
  assistantId: string;
  /** The element noVNC renders its canvas into. */
  container: HTMLElement;
  onState: (state: DesktopSessionState) => void;
  options?: DesktopSessionOptions;
}

export interface DesktopSession {
  /** End the session and release everything it holds. Idempotent. */
  close(): void;
}

/**
 * Open a session against `assistantId`, reporting every state change through
 * `onState`. Never reports after `close()`.
 */
export function openDesktopSession({
  assistantId,
  container,
  onState,
  options = {},
}: OpenDesktopSessionArgs): DesktopSession {
  let done = false;
  let ws: WebSocket | null = null;
  let rfb: RFB | null = null;
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
      ws = (options.webSocketFactory ?? ((u: string) => new WebSocket(u)))(url);
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
    client.scaleViewport = true;
    client.resizeSession = true;
    client.clipViewport = false;
    client.addEventListener("connect", () => {
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
      void navigator.clipboard?.writeText(event.detail.text).catch(() => {});
    });

    // Local copy: text copied anywhere in this window is offered to the pod's
    // clipboard, so a paste on the desktop finds it.
    const onCopy = (): void => {
      const text = document.getSelection()?.toString();
      if (text) {
        client.clipboardPasteFrom(text);
      }
    };
    window.addEventListener("copy", onCopy);
    teardown.push(() => window.removeEventListener("copy", onCopy));

    // Text copied in another app reaches the pod when the window comes back
    // into focus. Reading the clipboard needs a permission the browser may
    // withhold; a refusal leaves the remote clipboard as it was.
    const onFocus = (): void => {
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (!done && text) {
            client.clipboardPasteFrom(text);
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    teardown.push(() => window.removeEventListener("focus", onFocus));
  };

  onState({ kind: "connecting" });
  void (options.resolveWsUrl ?? resolveDesktopStreamWsUrl)(assistantId).then(
    (url) => {
      if (!done) {
        attach(url);
      }
    },
    (err: unknown) => {
      console.warn("desktop-session: no desktop transport", err);
      end(desktopEndReasonForResolveError(err));
    },
  );

  return {
    close: () => {
      if (done) {
        return;
      }
      done = true;
      release();
    },
  };
}
