import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render } from "@/test-utils.js";

const invalidateQueriesMock = mock(() => {});
const cancelStreamMock = mock(() => {});
const subscribeChatEventsMock = mock(
  (
    _assistantId: string,
    _conversationKey: string | null | undefined,
    _onEvent: unknown,
    _onError: (error: Error) => void,
  ) => ({
    cancel: cancelStreamMock,
  }),
);

mock.module("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: mock(() => ({
    data: { results: [{ id: "asst_test" }] },
  })),
  useQueryClient: mock(() => ({
    invalidateQueries: invalidateQueriesMock,
  })),
}));

mock.module("@/domains/chat/lib/api", () => ({
  subscribeChatEvents: subscribeChatEventsMock,
}));

mock.module("@/lib/native-auth.js", () => ({
  isNativePlatform: mock(() => false),
}));

import { SettingsSyncBridge } from "@/domains/settings/_components/settings-sync-bridge.js";

beforeEach(() => {
  invalidateQueriesMock.mockClear();
  cancelStreamMock.mockClear();
  subscribeChatEventsMock.mockClear();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(cleanup);

describe("SettingsSyncBridge", () => {
  test("broadly refreshes settings sync queries when the app becomes visible", async () => {
    render(<SettingsSyncBridge />);

    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["daemon-config", "asst_test"],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["soundsConfig", "asst_test"],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["soundsAvailable", "asst_test"],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["schedules", "asst_test"],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["schedule-runs", "asst_test"],
    });
  });

  test("restarts the settings event stream after terminal stream errors", async () => {
    render(<SettingsSyncBridge streamRetryDelayMs={1} />);

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    const onError = subscribeChatEventsMock.mock.calls[0]?.[3] as
      | ((error: Error) => void)
      | undefined;
    expect(onError).toBeTruthy();

    onError?.(new Error("stream exhausted"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(2);
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["schedules", "asst_test"],
    });
  });
});
