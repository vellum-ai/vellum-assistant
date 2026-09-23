import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, mock, test } from "bun:test";

const publish = mock((_name: string) => {});
mock.module("@/runtime/identity", () => ({ setAssistantName: publish }));
mock.module("@/stores/assistant-identity-store", () => ({
  useAssistantIdentityStore: { use: { name: () => "Example Assistant" } },
}));

const { useElectronIdentitySync } =
  await import("./use-electron-identity-sync");
afterEach(cleanup);

test("withholds cached identity until the assistant is ready", () => {
  const view = renderHook(({ ready }) => useElectronIdentitySync(ready), {
    initialProps: { ready: false },
  });
  expect(publish).toHaveBeenLastCalledWith("");
  view.rerender({ ready: true });
  expect(publish).toHaveBeenLastCalledWith("Example Assistant");
  view.rerender({ ready: false });
  expect(publish).toHaveBeenLastCalledWith("");
});
