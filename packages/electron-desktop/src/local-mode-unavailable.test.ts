import { expect, test } from "bun:test";

import type { IpcHandle } from "./ipc";
import { configureUnavailableLocalMode, installLocalMode } from "./local-mode";
const handlers: Record<string, (...args: unknown[]) => unknown> = {};
const handle: IpcHandle = (channel, schema, fn): void => {
  handlers[channel] = (...args) => fn(schema.parse(args), {} as never);
};

test("the unavailable runtime preserves the structured bridge contract", async () => {
  const error = "Local mode is unavailable";
  configureUnavailableLocalMode(handle, error);
  installLocalMode();

  const invoke = (name: string, ...args: unknown[]) =>
    handlers[`vellum:localMode:${name}`]!(...args);
  expect(await invoke("hatch", "vellum")).toEqual({ ok: false, error });
  expect(await invoke("listDevices", "assistant-1")).toEqual({
    ok: false,
    error,
  });
  expect(await invoke("revokeDevice", "assistant-1", "hash-1")).toEqual({
    ok: false,
    error,
  });
  const status = await invoke("status", "assistant-1");
  expect(status).toMatchObject({ ok: false, status: 501 });
  expect(() => invoke("readLockfile")).toThrow(error);
});
