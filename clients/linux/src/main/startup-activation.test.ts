import { beforeEach, expect, mock, test } from "bun:test";

let secondInstance: (_event: unknown, args: string[]) => void;
mock.module("electron", () => ({
  app: {
    on: (_event: string, callback: typeof secondInstance) => {
      secondInstance = callback;
    },
  },
}));
const { installStartupActivation } = await import("./startup-activation");
const show = mock(async () => {});
beforeEach(() => show.mockClear());

test("a background login stays hidden and an ordinary relaunch opens it", () => {
  installStartupActivation(show, ["/opt/Vellum.AppImage", "--hidden"]);
  expect(show).not.toHaveBeenCalled();
  secondInstance({}, ["/opt/Vellum.AppImage", "--hidden"]);
  expect(show).not.toHaveBeenCalled();
  secondInstance({}, ["/opt/Vellum.AppImage"]);
  expect(show).toHaveBeenCalledTimes(1);
});

test("an ordinary launch opens and a background relaunch does not steal focus", () => {
  installStartupActivation(show, ["/opt/Vellum.AppImage"]);
  expect(show).toHaveBeenCalledTimes(1);
  secondInstance({}, ["/opt/Vellum.AppImage", "--hidden"]);
  expect(show).toHaveBeenCalledTimes(1);
});
