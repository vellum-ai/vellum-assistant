import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { client } from "@/generated/daemon/client.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

mock.module("@/hooks/use-is-org-ready", () => ({ useIsOrgReady: () => true }));
const listeners = new Map<string, (event: unknown) => void>();
mock.module("@/hooks/use-bus-subscription", () => ({
  useBusSubscription: (name: string, listener: (event: unknown) => void) => {
    listeners.set(name, listener);
  },
}));
const { DesktopControlPanel } = await import("./desktop-control-panel");
const originalGet = client.get;
const originalPost = client.post;
let queryClient: QueryClient;
let state: "idle" | "assistant" | "human";
let status: number;
const requests: string[] = [];

beforeEach(() => {
  state = "assistant";
  status = 200;
  requests.length = 0;
  useAssistantFeatureFlagStore
    .getState()
    .setFlags({ assistantDesktopControl: true });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.get = mock(async () => ({
    data: status === 200 ? { state } : undefined,
    response: new Response(null, { status }),
  })) as unknown as typeof client.get;
  client.post = mock(async (options: { body: { action: string } }) => {
    requests.push(options.body.action);
    state = options.body.action === "take" ? "human" : "idle";
    return { data: { state }, response: new Response() };
  }) as unknown as typeof client.post;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  client.get = originalGet;
  client.post = originalPost;
  listeners.clear();
  useAssistantFeatureFlagStore.getState().resetForAssistantSwitch();
});
function mount() {
  render(
    <QueryClientProvider client={queryClient}>
      <DesktopControlPanel assistantId="assistant-123">
        {(viewOnly) => (
          <div data-testid="viewer" data-readonly={String(viewOnly)} />
        )}
      </DesktopControlPanel>
    </QueryClientProvider>,
  );
}
function readOnly() {
  return screen.getByTestId("viewer").getAttribute("data-readonly");
}

test("takes control, allows the assistant, and observes subsequent ownership through sync", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Take control" }));
  await screen.findByRole("button", { name: "Allow assistant" });
  await waitFor(() => expect(readOnly()).toBe("false"));
  expect(requests).toEqual(["take"]);
  fireEvent.click(screen.getByRole("button", { name: "Allow assistant" }));
  await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  expect(requests).toEqual(["take", "allow"]);
  state = "assistant";
  act(() =>
    listeners.get("sse.event")?.({
      message: { type: "sync_changed", tags: ["assistant:self:desktop"] },
    }),
  );
  await screen.findByRole("button", { name: "Take control" });
  expect(readOnly()).toBe("true");
});

test("disabled control makes no API requests and preserves interactive viewing", () => {
  useAssistantFeatureFlagStore
    .getState()
    .setFlags({ assistantDesktopControl: false });
  mount();
  expect(client.get).not.toHaveBeenCalled();
  expect(readOnly()).toBe("false");
  expect(screen.queryByRole("button")).toBeNull();
});

test("status failure blocks input until a successful reconnect refresh", async () => {
  status = 503;
  mount();
  const reconnect = await screen.findByRole("button", { name: "Reconnect" });
  expect(readOnly()).toBe("true");
  status = 200;
  state = "human";
  fireEvent.click(reconnect);
  await screen.findByRole("button", { name: "Allow assistant" });
  await waitFor(() => expect(readOnly()).toBe("false"));
});

test("older assistants retain interactive viewing when the control route is absent", async () => {
  status = 404;
  mount();
  await waitFor(() => expect(readOnly()).toBe("false"));
  expect(requests).toEqual([]);
  expect(screen.queryByRole("button")).toBeNull();
});
