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
mock.module("@/hooks/use-is-org-ready", () => ({ useIsOrgReady: () => true }));
const listeners = new Map<string, (event: unknown) => void>();
mock.module("@/hooks/use-bus-subscription", () => ({
  useBusSubscription: (name: string, listener: (event: unknown) => void) => {
    listeners.set(name, listener);
  },
}));
const { DesktopPanel } = await import("./desktop-panel");

const originalGet = client.get;
const originalPost = client.post;
let state = "required";
let missingRoute = false;
let postCalls = 0;
let queryClient: QueryClient;

beforeEach(() => {
  state = "required";
  missingRoute = false;
  postCalls = 0;
  open.mockClear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.get = mock(async () => ({
    data: { state },
    response: new Response(null, { status: missingRoute ? 404 : 200 }),
  })) as unknown as typeof client.get;
  client.post = mock(async () => {
    postCalls++;
    state = "installing";
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

test("opening only checks setup; installing shows progress and opens the desktop when ready", async () => {
  mount();
  const install = await screen.findByRole("button", {
    name: "Install desktop",
  });
  expect(postCalls).toBe(0);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(install);
  await screen.findByText("Installing desktop components…");
  expect(postCalls).toBe(1);
  expect(open).not.toHaveBeenCalled();
  state = "ready";
  notify();
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
});

test("reopening observes an existing install and offers retry after failure", async () => {
  state = "installing";
  mount();
  await screen.findByText("Installing desktop components…");
  expect(postCalls).toBe(0);
  state = "failed";
  notify();
  fireEvent.click(
    await screen.findByRole("button", { name: "Install desktop" }),
  );
  await screen.findByText("Installing desktop components…");
  expect(postCalls).toBe(1);
});

test("older assistants keep their existing streaming flow without an install request", async () => {
  missingRoute = true;
  mount();
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect(postCalls).toBe(0);
});
