/**
 * The desktop panel's states, driven from the two things that can end a
 * session: the socket's close code and noVNC's own events.
 *
 * noVNC is stood in for with a fake that records what the session configures
 * and lets a test raise its events; the socket is a fake handed in through the
 * session's factory seam. No real socket or display is touched.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import type { DesktopSessionOptions } from "./desktop-session";

type Listener = (event: unknown) => void;

class FakeRFB {
  static instances: FakeRFB[] = [];
  channel: unknown;
  scaleViewport = false;
  resizeSession = false;
  clipViewport = true;
  disconnectCalls = 0;
  private listeners = new Map<string, Listener[]>();

  constructor(_target: HTMLElement, channel: unknown) {
    this.channel = channel;
    FakeRFB.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  clipboardPasteFrom(_text: string): void {}

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  emit(type: string, detail: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ detail });
    }
  }
}

mock.module("@novnc/novnc", () => ({ default: FakeRFB }));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  binaryType = "blob";
  readyState = 0;
  closeCalls: number[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(code: number): void {
    this.closeCalls.push(code);
    this.readyState = 2;
  }

  serverClose(code: number): void {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) {
      listener({ code });
    }
  }
}

const { DesktopPanel } = await import("./desktop-panel");

/** The URL the resolver answers with, or an error it throws. */
let resolved: string | Error = "ws://127.0.0.1:8500/v1/desktop/stream?token=t";

const sessionOptions: DesktopSessionOptions = {
  webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
  resolveWsUrl: async () => {
    if (resolved instanceof Error) {
      throw resolved;
    }
    return resolved;
  },
};

const rfb = (): FakeRFB => {
  const last = FakeRFB.instances.at(-1);
  if (!last) {
    throw new Error("Expected noVNC to have been attached");
  }
  return last;
};

const socket = (): FakeWebSocket => {
  const last = FakeWebSocket.instances.at(-1);
  if (!last) {
    throw new Error("Expected a socket to have been opened");
  }
  return last;
};

const status = (): string | null =>
  screen.queryByTestId("desktop-panel-status")?.getAttribute("data-state") ??
  null;

/** Mount the panel and let the URL resolve, which is when noVNC attaches. */
const mountPanel = async () => {
  render(<DesktopPanel assistantId="asst-1" sessionOptions={sessionOptions} />);
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  FakeRFB.instances = [];
  FakeWebSocket.instances = [];
  resolved = "ws://127.0.0.1:8500/v1/desktop/stream?token=t";
});

afterEach(() => {
  cleanup();
});

describe("DesktopPanel", () => {
  test("hands noVNC the open socket, scaled and driving the remote size", async () => {
    await mountPanel();

    expect(socket().binaryType).toBe("arraybuffer");
    expect(rfb().channel).toBe(socket());
    expect(rfb().scaleViewport).toBe(true);
    expect(rfb().resizeSession).toBe(true);
    expect(rfb().clipViewport).toBe(false);
    expect(status()).toBe("connecting");
  });

  test("clears the status overlay once noVNC connects", async () => {
    await mountPanel();

    act(() => rfb().emit("connect"));

    expect(status()).toBeNull();
  });

  test("1013 says another viewer has the desktop, with no reconnect", async () => {
    await mountPanel();

    act(() => socket().serverClose(1013));

    expect(status()).toBe("busy");
    expect(
      screen.getByText("The desktop is in use by another viewer."),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  test("1008 says the assistant has no desktop, with no reconnect", async () => {
    await mountPanel();

    act(() => socket().serverClose(1008));

    expect(status()).toBe("unavailable");
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  test("1011 says the desktop could not start and offers a reconnect", async () => {
    await mountPanel();

    act(() => socket().serverClose(1011));

    expect(status()).toBe("failed");
    expect(screen.getByText("The desktop couldn't start.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect" })).not.toBeNull();
  });

  test("any other close is a lost connection with a reconnect", async () => {
    await mountPanel();
    act(() => rfb().emit("connect"));

    act(() => socket().serverClose(1006));

    expect(status()).toBe("lost");
    expect(screen.getByRole("button", { name: "Reconnect" })).not.toBeNull();
  });

  /**
   * The close code is the runtime's word and noVNC's `disconnect` follows it
   * on the same socket; the code has to win or every refusal would read as a
   * dropped connection.
   */
  test("a disconnect after a coded close keeps the code's reason", async () => {
    await mountPanel();

    act(() => {
      socket().serverClose(1013);
      rfb().emit("disconnect", { clean: false });
    });

    expect(status()).toBe("busy");
  });

  test("a security failure ends as a desktop that could not start", async () => {
    await mountPanel();

    act(() => rfb().emit("securityfailure", { status: 1 }));

    expect(status()).toBe("failed");
    expect(rfb().disconnectCalls).toBe(1);
  });

  test("reconnect opens a fresh session", async () => {
    await mountPanel();
    act(() => socket().serverClose(1006));

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeRFB.instances).toHaveLength(2);
    expect(status()).toBe("connecting");
  });

  test("a paired assistant is refused as unavailable rather than left hanging", async () => {
    const { PairedVoiceUnavailableError } =
      await import("@/domains/chat/voice/live-voice/connection");
    resolved = new PairedVoiceUnavailableError();

    await mountPanel();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(status()).toBe("unavailable");
  });

  test("a remote copy lands on the local clipboard", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
        readText: async () => "",
      },
    });
    await mountPanel();

    act(() => rfb().emit("clipboard", { text: "from the pod" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(written).toEqual(["from the pod"]);
  });

  test("closes the session on unmount", async () => {
    await mountPanel();

    cleanup();

    expect(rfb().disconnectCalls).toBe(1);
  });
});
