import { beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";

// Capture what `handle`/`on` register so the tests can invoke the
// wrapped callback with synthetic events, exercising the real origin
// guard and schema parse rather than the production `ipcMain`.
type RawHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, RawHandler>();
const listeners = new Map<string, RawHandler>();

const appState = { isPackaged: false };
mock.module("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
  },
  ipcMain: {
    handle: (channel: string, h: RawHandler) => handlers.set(channel, h),
    on: (channel: string, l: RawHandler) => listeners.set(channel, l),
  },
}));

const { handle, on } = await import("./ipc");
const { resolveAllowedOrigin } = await import("./app-origin");

// The guard derives the allowed origin from the same resolver the
// production code uses, so the synthetic sender tracks the dev/packaged
// toggle without hard-coding either origin.
const allowedEvent = (): { senderFrame: { origin: string } } => {
  const { protocol, host } = resolveAllowedOrigin();
  return { senderFrame: { origin: `${protocol}//${host}` } };
};
const foreignEvent = { senderFrame: { origin: "https://evil.example.com" } };
const noFrameEvent = {};

beforeEach(() => {
  appState.isPackaged = false;
  handlers.clear();
  listeners.clear();
  delete process.env.VELLUM_DEV_URL;
});

describe("handle (invocable)", () => {
  test("dispatches the parsed argument tuple when sender and shape are valid", () => {
    const fn = mock((args: [number]) => args[0] * 2);
    handle("c", z.tuple([z.number()]), fn);

    const result = handlers.get("c")!(allowedEvent(), 21);

    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toEqual([21]);
  });

  test("accepts the packaged app:// sender", () => {
    appState.isPackaged = true;
    const fn = mock(() => "ok");
    handle("c", z.tuple([]), fn);

    expect(handlers.get("c")!(allowedEvent())).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("throws and never runs the body for a foreign sender", () => {
    const fn = mock(() => "ok");
    handle("c", z.tuple([z.number()]), fn);

    expect(() => handlers.get("c")!(foreignEvent, 1)).toThrow(
      /sender is not the app renderer/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  test("throws and never runs the body for a frameless sender", () => {
    const fn = mock(() => "ok");
    handle("c", z.tuple([z.number()]), fn);

    expect(() => handlers.get("c")!(noFrameEvent, 1)).toThrow(
      /sender is not the app renderer/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  test("throws and never runs the body when the argument shape is wrong", () => {
    const fn = mock(() => "ok");
    handle("c", z.tuple([z.number()]), fn);

    expect(() => handlers.get("c")!(allowedEvent(), "not-a-number")).toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("on (fire-and-forget)", () => {
  test("dispatches the parsed tuple when sender and shape are valid", () => {
    const fn = mock((_args: [boolean]) => undefined);
    on("c", z.tuple([z.boolean()]), fn);

    listeners.get("c")!(allowedEvent(), true);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toEqual([true]);
  });

  test("silently drops a foreign sender (no throw, body never runs)", () => {
    const fn = mock(() => undefined);
    on("c", z.tuple([z.boolean()]), fn);

    expect(() => listeners.get("c")!(foreignEvent, true)).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  test("silently drops a malformed payload (no throw, body never runs)", () => {
    const fn = mock(() => undefined);
    on("c", z.tuple([z.boolean()]), fn);

    expect(() => listeners.get("c")!(allowedEvent(), "nope")).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
