import { beforeEach, describe, expect, mock, test } from "bun:test";

type BeforeRequestListener = (
  details: { frame?: { origin: string } | null },
  callback: (response: { cancel?: boolean }) => void,
) => void;

let registeredFilter: { urls: string[] } | undefined;
let registeredListener: BeforeRequestListener | null | undefined;
const onBeforeRequest = mock(
  (filter: { urls: string[] }, listener: BeforeRequestListener | null) => {
    registeredFilter = filter;
    registeredListener = listener;
  },
);

mock.module("electron", () => ({
  app: { isPackaged: true },
  session: { defaultSession: { webRequest: { onBeforeRequest } } },
}));

const { installPairedGatewayRequestGuard } =
  await import("./paired-gateway-request-guard");

const APP_ORIGIN = { protocol: "app:", host: "vellum.ai" };

beforeEach(() => {
  registeredFilter = undefined;
  registeredListener = undefined;
  onBeforeRequest.mockClear();
});

describe("installPairedGatewayRequestGuard", () => {
  test("gates both supported paired proxy paths by frame origin", () => {
    const remove = installPairedGatewayRequestGuard(APP_ORIGIN);

    expect(registeredFilter?.urls).toEqual([
      "app://vellum.ai/assistant/__gateway-paired/*",
      "app://vellum.ai/__gateway-paired/*",
    ]);

    let cancel: boolean | undefined;
    registeredListener?.(
      { frame: { origin: "app://vellum.ai" } },
      (response) => {
        cancel = response.cancel;
      },
    );
    expect(cancel).toBe(false);

    registeredListener?.(
      { frame: { origin: "http://127.0.0.1:9999" } },
      (response) => {
        cancel = response.cancel;
      },
    );
    expect(cancel).toBe(true);

    registeredListener?.({ frame: null }, (response) => {
      cancel = response.cancel;
    });
    expect(cancel).toBe(true);

    remove();
    expect(onBeforeRequest).toHaveBeenLastCalledWith(registeredFilter, null);
  });
});
