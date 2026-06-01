import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { __resetEventBusForTesting } from "@/stores/event-bus-store";

// Mock the heavy upstream modules so the import chain
// (`sseService → lifecycleService → assistant/api`) doesn't try to
// touch the daemon at module-eval time. The hook's contract with
// `sseService` is asserted via `spyOn` on the real object below —
// `mock.module` for `@/assistant/sse-service` would work for this
// file but `mock.module` is process-global in bun, so it would
// leak into `sse-service.test.ts` and shadow the real
// implementation that test exercises.
mock.module("@/lib/streaming/stream-transport", () => ({
  subscribeChatEvents: () => ({ cancel: () => {} }),
}));
mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: { checkAssistant: async () => {} },
}));

const { sseService } = await import("@/assistant/sse-service");
const { useEventBusInit } = await import("@/hooks/use-event-bus-init");

const detachMock = mock(() => {});
const attachSpy = spyOn(sseService, "attach").mockImplementation(
  () => detachMock,
);

beforeEach(() => {
  __resetEventBusForTesting();
  attachSpy.mockClear();
  detachMock.mockClear();
});

afterEach(() => {
  cleanup();
  __resetEventBusForTesting();
});

afterAll(() => {
  attachSpy.mockRestore();
});

describe("useEventBusInit — sseService adapter contract", () => {
  test("does not attach when assistant is not active", () => {
    renderHook(() =>
      useEventBusInit({ assistantId: "asst-1", isAssistantActive: false }),
    );
    expect(attachSpy).not.toHaveBeenCalled();
  });

  test("does not attach when assistantId is null", () => {
    renderHook(() =>
      useEventBusInit({ assistantId: null, isAssistantActive: true }),
    );
    expect(attachSpy).not.toHaveBeenCalled();
  });

  test("attaches sseService when assistant becomes active", () => {
    renderHook(() =>
      useEventBusInit({ assistantId: "asst-1", isAssistantActive: true }),
    );
    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy.mock.calls[0]![1]).toBe("asst-1");
  });

  test("calls the returned detach on unmount", () => {
    const { unmount } = renderHook(() =>
      useEventBusInit({ assistantId: "asst-1", isAssistantActive: true }),
    );
    expect(detachMock).not.toHaveBeenCalled();
    unmount();
    expect(detachMock).toHaveBeenCalledTimes(1);
  });

  test("changing assistantId detaches and re-attaches", () => {
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useEventBusInit({
          assistantId: id,
          isAssistantActive: id != null,
        }),
      { initialProps: { id: "asst-1" } as { id: string | null } },
    );
    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy.mock.calls[0]![1]).toBe("asst-1");

    rerender({ id: "asst-2" });

    expect(detachMock).toHaveBeenCalledTimes(1);
    expect(attachSpy).toHaveBeenCalledTimes(2);
    expect(attachSpy.mock.calls[1]![1]).toBe("asst-2");
  });

  test("flipping to inactive detaches without re-attaching", () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useEventBusInit({ assistantId: "asst-1", isAssistantActive: active }),
      { initialProps: { active: true } },
    );
    expect(attachSpy).toHaveBeenCalledTimes(1);

    rerender({ active: false });

    expect(detachMock).toHaveBeenCalledTimes(1);
    expect(attachSpy).toHaveBeenCalledTimes(1);
  });
});
