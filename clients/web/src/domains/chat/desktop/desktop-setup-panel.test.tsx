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

const open = mock(() => ({
  close: mock(() => {}),
  setViewOnly: mock(() => {}),
}));
mock.module("./desktop-session", () => ({ openDesktopSession: open }));
let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));
const listeners = new Map<string, (event: unknown) => void>();
mock.module("@/hooks/use-bus-subscription", () => ({
  useBusSubscription: (name: string, listener: (event: unknown) => void) => {
    listeners.set(name, listener);
  },
}));
const { DesktopPanel } = await import("./desktop-panel");
const { useDesktopSetupStatus } = await import("./use-desktop-setup");

const originalGet = client.get;
const originalPost = client.post;
let state = "ready";
let automationActive = false;
let missingRoute = false;
let postCalls = 0;
let queryClient: QueryClient;

beforeEach(() => {
  state = "ready";
  automationActive = false;
  orgReady = true;
  missingRoute = false;
  postCalls = 0;
  open.mockClear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.get = mock(async () => ({
    data: { state, automationActive },
    response: new Response(null, { status: missingRoute ? 404 : 200 }),
  })) as unknown as typeof client.get;
  client.post = mock(async () => {
    postCalls++;
    return { data: { state }, response: new Response() };
  }) as unknown as typeof client.post;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  client.get = originalGet;
  client.post = originalPost;
  listeners.clear();
});

function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <DesktopPanel assistantId="assistant-123" />
    </QueryClientProvider>,
  );
}

function notify() {
  act(() =>
    listeners.get("sse.event")?.({
      message: { type: "sync_changed", tags: ["assistant:self:desktop"] },
    }),
  );
}

test("opening a ready image starts the viewer without a setup request", async () => {
  mount();
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect(postCalls).toBe(0);
});

for (const unavailable of ["failed", "unsupported", "required", "installing"]) {
  test(`an unavailable desktop (${unavailable}) never starts installation`, async () => {
    state = unavailable;
    mount();
    await screen.findByText(
      "The virtual desktop isn't available on this assistant.",
    );
    expect(postCalls).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
    state = "ready";
    notify();
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(postCalls).toBe(0);
  });
}

test("older assistants keep their existing streaming flow without an install request", async () => {
  missingRoute = true;
  const panel = mount();
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  panel.unmount();
  mount();
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(client.get).toHaveBeenCalledTimes(1);
  expect(postCalls).toBe(0);
  act(() => listeners.get("sse.opened")?.({}));
  await waitFor(() => expect(client.get).toHaveBeenCalledTimes(2));
});

test("a failed readiness request offers a read-only reconnect", async () => {
  const get = client.get;
  client.get = mock(async () => {
    throw new Error("request failed");
  }) as unknown as typeof client.get;
  mount();
  const retry = await screen.findByRole("button", { name: "Reconnect" });
  expect(open).not.toHaveBeenCalled();
  client.get = get;
  fireEvent.click(retry);
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect(postCalls).toBe(0);
});

test("setup waits for organization readiness", async () => {
  orgReady = false;
  const panel = mount();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(client.get).not.toHaveBeenCalled();
  expect(postCalls).toBe(0);
  orgReady = true;
  panel.rerender(
    <QueryClientProvider client={queryClient}>
      <DesktopPanel assistantId="assistant-123" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect(postCalls).toBe(0);
});

test("reading desktop activity never installs and refreshes on activity and reconnect", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <Activity />
    </QueryClientProvider>,
  );
  await screen.findByText("false");
  expect(postCalls).toBe(0);
  automationActive = true;
  act(() =>
    listeners.get("sse.event")?.({
      message: { type: "desktop_activity_changed" },
    }),
  );
  await screen.findByText("true");
  automationActive = false;
  act(() => listeners.get("sse.opened")?.({}));
  await screen.findByText("false");
  expect(postCalls).toBe(0);
});

function Activity() {
  const { query } = useDesktopSetupStatus("assistant-123");
  return <output>{String(query.data?.automationActive)}</output>;
}

test("remounting desktop activity catches completion while the drawer was closed", async () => {
  automationActive = true;
  const activity = render(
    <QueryClientProvider client={queryClient}>
      <Activity />
    </QueryClientProvider>,
  );
  await screen.findByText("true");
  activity.unmount();
  automationActive = false;
  render(
    <QueryClientProvider client={queryClient}>
      <Activity />
    </QueryClientProvider>,
  );
  await screen.findByText("false");
  expect(client.get).toHaveBeenCalledTimes(2);
  expect(postCalls).toBe(0);
});
