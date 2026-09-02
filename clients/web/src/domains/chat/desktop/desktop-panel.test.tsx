/**
 * The desktop panel's states, driven from the things that can end a session:
 * the socket's close code, noVNC's own events, and the connect timeout.
 *
 * noVNC is stood in for with a fake that records what the session configures
 * and lets a test raise its events; the global WebSocket is a fake, and the
 * URL resolver is mocked so no transport rules run here.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

type Listener = (event: unknown) => void;

class FakeRFB {
  static instances: FakeRFB[] = [];
  channel: unknown;
  scaleViewport = false;
  resizeSession = false;
  clipViewport = true;
  disconnectCalls = 0;
  pasted: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(_target: HTMLElement, channel: unknown) {
    this.channel = channel;
    FakeRFB.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  clipboardPasteFrom(text: string): void {
    this.pasted.push(text);
  }

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
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
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

const originalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

/** The URL the resolver answers with, or an error it throws. */
let resolved: string | Error = "ws://127.0.0.1:8500/v1/desktop/stream?token=t";

const connection = await import("./desktop-connection");
mock.module("./desktop-connection", () => ({
  ...connection,
  resolveDesktopStreamWsUrl: mock(async () => {
    if (resolved instanceof Error) {
      throw resolved;
    }
    return resolved;
  }),
}));

const { DesktopPanel } = await import("./desktop-panel");

// bun:test has no fake timers, so the session's connect timeout is captured
// from a patched `setTimeout` and fired by hand.
interface Timeout {
  fn: () => void;
  ms: number;
  cleared: boolean;
}
let timeouts: Timeout[] = [];
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

/** The session's connect timeout, whether or not it has since been cleared. */
const connectTimer = (): Timeout => {
  const timer = timeouts.find((t) => t.ms === 15_000);
  if (!timer) {
    throw new Error("Expected the session to arm a connect timeout");
  }
  return timer;
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

/** Let pending microtasks (URL resolution, clipboard promises) settle. */
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

/** Mount the panel and let the URL resolve, which is when noVNC attaches. */
const mountPanel = async () => {
  render(<DesktopPanel assistantId="asst-1" />);
  await flush();
};

beforeEach(() => {
  FakeRFB.instances = [];
  FakeWebSocket.instances = [];
  timeouts = [];
  resolved = "ws://127.0.0.1:8500/v1/desktop/stream?token=t";
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    timeouts.push({ fn, ms: ms ?? 0, cleared: false });
    return timeouts.length;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    const timer = typeof id === "number" ? timeouts[id - 1] : undefined;
    if (timer) {
      timer.cleared = true;
    }
  }) as typeof globalThis.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
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

  test("4013 says another viewer has the desktop, with no reconnect", async () => {
    await mountPanel();

    act(() => socket().serverClose(4013));

    expect(status()).toBe("busy");
    expect(
      screen.getByText("The desktop is in use by another viewer."),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  test("4008 says the assistant has no desktop, with no reconnect", async () => {
    await mountPanel();

    act(() => socket().serverClose(4008));

    expect(status()).toBe("unavailable");
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  test("4011 says the desktop could not start and offers a reconnect", async () => {
    await mountPanel();

    act(() => socket().serverClose(4011));

    expect(status()).toBe("failed");
    expect(screen.getByText("The desktop couldn't start.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect" })).not.toBeNull();
  });

  test("velay's 1013 tunnel drop is a lost connection with a reconnect", async () => {
    await mountPanel();
    act(() => rfb().emit("connect"));

    act(() => socket().serverClose(1013));

    expect(status()).toBe("lost");
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
      socket().serverClose(4013);
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

  test("a socket that never opens times out as a lost connection", async () => {
    await mountPanel();

    act(() => connectTimer().fn());

    expect(status()).toBe("lost");
    expect(rfb().disconnectCalls).toBe(1);
    expect(screen.getByRole("button", { name: "Reconnect" })).not.toBeNull();
  });

  test("a session that connects in time disarms the timeout", async () => {
    await mountPanel();

    act(() => rfb().emit("connect"));

    expect(connectTimer().cleared).toBe(true);
  });

  test("unmounting while connecting disarms the timeout", async () => {
    await mountPanel();

    cleanup();

    expect(connectTimer().cleared).toBe(true);
  });

  test("reconnect opens a fresh session", async () => {
    await mountPanel();
    act(() => socket().serverClose(1006));

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await flush();

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
        readText: async () => "never read",
      },
    });
    await mountPanel();

    act(() => rfb().emit("clipboard", { text: "from the pod" }));
    await flush();

    expect(written).toEqual(["from the pod"]);
  });

  test("a local copy reaches the pod; the clipboard is never read on focus", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {},
        readText: async () => "copied in another app",
      },
    });
    await mountPanel();
    const node = document.createTextNode("selected here");
    document.body.appendChild(node);
    document.getSelection()?.selectAllChildren(document.body);
    const selected = document.getSelection()?.toString() ?? "";
    expect(selected).toContain("selected here");

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("copy"));
    });
    await flush();

    expect(rfb().pasted).toEqual([selected]);
    node.remove();
  });

  test("closes the session on unmount", async () => {
    await mountPanel();

    cleanup();

    expect(rfb().disconnectCalls).toBe(1);
  });
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
});
