/**
 * One viewing session on the assistant desktop. The socket is opened here
 * rather than by noVNC because noVNC's `disconnect` event carries only
 * `{ clean }` and the close code is the runtime's only word on why a session
 * ended; the close listener is registered before noVNC attaches so the coded
 * reason wins.
 */

import RFB from "@novnc/novnc";

import { PairedVoiceUnavailableError } from "@/domains/chat/voice/live-voice/connection";

import {
  desktopEndReasonForClose,
  resolveDesktopStreamWsUrl,
  type DesktopEndReason,
} from "./desktop-connection";

/** Give up on a socket that has neither opened nor been refused by then. */
const CONNECT_TIMEOUT_MS = 15_000;

export type DesktopSessionState =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "ended"; reason: DesktopEndReason };

export interface OpenDesktopSessionArgs {
  assistantId: string;
  /** The element noVNC renders its canvas into. */
  container: HTMLElement;
  onState: (state: DesktopSessionState) => void;
}

export interface DesktopSession {
  /** End the session and release everything it holds. Idempotent. */
  close(): void;
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
    client.scaleViewport = true;
    client.resizeSession = true;
    client.clipViewport = false;

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
      void navigator.clipboard?.writeText(event.detail.text).catch(() => {});
    });

    // Local copy: text copied in this window is offered to the pod's
    // clipboard. Only an explicit copy gesture reaches the pod; the clipboard
    // is never read on its own, since anything copied elsewhere is readable
    // by the assistant once it lands there.
    const onCopy = (): void => {
      const text = document.getSelection()?.toString();
      if (text) {
        client.clipboardPasteFrom(text);
      }
    };
    window.addEventListener("copy", onCopy);
    teardown.push(() => window.removeEventListener("copy", onCopy));
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
    close: () => {
      if (done) {
        return;
      }
      done = true;
      release();
    },
  };
}
