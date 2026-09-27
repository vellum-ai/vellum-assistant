import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  ConfigGetResponse,
  ConfigPatchData,
} from "@/generated/daemon/types.gen";

let supported: boolean | undefined = true;
let capabilityError = false;
const retryCapability = mock(() => {});
let orgReady = true;
let organizationId = "org-1";
let loadFailure = false;
let saveFailure = false;
let savedConfig: ConfigGetResponse;
let finishSave: (() => void) | undefined;
let deferSave = false;
let finishLoad: (() => void) | undefined;
let deferLoad = false;
const getConfig = mock(async (_assistantId: string) => {
  if (deferLoad) {
    await new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
  }
  if (loadFailure) {
    throw new Error("Load failed");
  }
  return savedConfig;
});
const patchConfig = mock(async (_options: ConfigPatchData) => {
  if (deferSave) {
    await new Promise<void>((resolve) => {
      finishSave = resolve;
    });
  }
  if (saveFailure) {
    throw new Error("Save failed");
  }
  return savedConfig;
});
const configKey = (assistantId: string) => ["config", assistantId];
mock.module("@/hooks/use-assistant-capability", () => ({
  useAssistantCapabilityQuery: () => ({
    data: supported,
    isPending: supported === undefined && !capabilityError,
    isError: capabilityError,
    refetch: retryCapability,
  }),
}));
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
  getOrgHeaderReadiness: () => (orgReady ? "ready" : "resolving"),
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));
mock.module("@/stores/organization-store", () => ({
  getActiveOrganizationIdForRequests: () => organizationId,
}));
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: ({ path }: ConfigPatchData) => ({
    queryKey: configKey(path.assistant_id),
    queryFn: () => getConfig(path.assistant_id),
  }),
  configGetSetQueryData: (
    client: QueryClient,
    { path }: ConfigPatchData,
    data: ConfigGetResponse,
  ) => client.setQueryData(configKey(path.assistant_id), data),
  useConfigPatchMutation: (options: object) =>
    useMutation({
      mutationFn: (variables: ConfigPatchData) => patchConfig(variables),
      ...options,
    }),
}));
const { useChatsSettings } = await import("./use-chats-settings");
let client: QueryClient;
const onSaved = mock(() => {});
beforeEach(() => {
  supported = true;
  capabilityError = false;
  retryCapability.mockClear();
  orgReady = true;
  organizationId = "org-1";
  loadFailure = false;
  saveFailure = false;
  deferSave = false;
  finishSave = undefined;
  deferLoad = false;
  finishLoad = undefined;
  savedConfig = {
    conversations: { autoArchive: { enabled: false, afterDays: 7 } },
    notifications: { newMessageEnabled: true },
  };
  getConfig.mockClear();
  patchConfig.mockClear();
  onSaved.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount(open = true) {
  return renderHook(
    ({ open }) =>
      useChatsSettings({ assistantId: "assistant-1", open, onSaved }),
    {
      initialProps: { open },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}
const changes = { notifications: { newMessageEnabled: false } };

test("loads selected assistant settings only when opened", async () => {
  const hook = mount(false);
  expect(getConfig).not.toHaveBeenCalled();
  hook.rerender({ open: true });
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  expect(getConfig).toHaveBeenCalledWith("assistant-1");
  expect(hook.result.current.state).toEqual({
    status: "ready",
    values: {
      autoArchive: { enabled: false, afterDays: 7 },
      newMessageEnabled: true,
    },
  });
});
test("a fresh session waits for current settings even when cached data exists", async () => {
  client.setQueryData(configKey("assistant-1"), savedConfig);
  savedConfig = { ...savedConfig, notifications: { newMessageEnabled: false } };
  deferLoad = true;
  const hook = mount();
  expect(hook.result.current.state.status).toBe("loading");
  await act(() => hook.result.current.save(changes));
  expect(patchConfig).not.toHaveBeenCalled();
  await act(async () => {
    finishLoad?.();
  });
  await waitFor(() =>
    expect(hook.result.current.state).toMatchObject({
      status: "ready",
      values: { newMessageEnabled: false },
    }),
  );
});
test("a failed opening refresh does not expose stale cached values", async () => {
  client.setQueryData(configKey("assistant-1"), savedConfig);
  loadFailure = true;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("error"));
  await act(() => hook.result.current.save(changes));
  expect(patchConfig).not.toHaveBeenCalled();
});
test("unsupported assistants cannot fetch or write guessed settings", async () => {
  supported = false;
  const hook = mount();
  expect(hook.result.current.state.status).toBe("unsupported");
  await act(() => hook.result.current.save(changes));
  expect(getConfig).not.toHaveBeenCalled();
  expect(patchConfig).not.toHaveBeenCalled();
});

test("waits for a capability response before fetching settings", async () => {
  supported = undefined;
  const hook = mount();
  expect(hook.result.current.state.status).toBe("loading");
  expect(getConfig).not.toHaveBeenCalled();
  supported = true;
  hook.rerender({ open: true });
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
});

test("capability failure offers retry instead of an unsupported state", async () => {
  supported = undefined;
  capabilityError = true;
  const hook = mount();
  expect(hook.result.current.state.status).toBe("error");
  act(() => hook.result.current.retryLoad());
  expect(retryCapability).toHaveBeenCalledTimes(1);
  expect(getConfig).not.toHaveBeenCalled();
  capabilityError = false;
  supported = true;
  hook.rerender({ open: true });
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
});

test("a failed capability refresh preserves the loaded form", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  capabilityError = true;
  hook.rerender({ open: true });
  expect(hook.result.current.state.status).toBe("ready");
});

test("one retry refreshes settings and a failed background capability check", async () => {
  capabilityError = true;
  loadFailure = true;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("error"));
  loadFailure = false;
  act(() => hook.result.current.retryLoad());
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  expect(retryCapability).toHaveBeenCalledTimes(1);
});
test("waits for organization readiness and blocks writes while it changes", async () => {
  orgReady = false;
  const hook = mount();
  expect(hook.result.current.state.status).toBe("loading");
  expect(getConfig).not.toHaveBeenCalled();
  orgReady = true;
  hook.rerender({ open: true });
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  orgReady = false;
  await act(() => hook.result.current.save(changes));
  expect(patchConfig).not.toHaveBeenCalled();
});
test("load failures can retry without exposing editable defaults", async () => {
  loadFailure = true;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("error"));
  loadFailure = false;
  act(() => hook.result.current.retryLoad());
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
});
test("a supported response missing settings is an error", async () => {
  savedConfig = {};
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("error"));
  await act(() => hook.result.current.save(changes));
  expect(patchConfig).not.toHaveBeenCalled();
});
test("submits only changed leaves once and updates the owning cache", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  client.setQueryData(configKey("assistant-2"), { marker: "other" });
  savedConfig = { ...savedConfig, notifications: { newMessageEnabled: false } };
  deferSave = true;
  let saving: Promise<void> | undefined;
  act(() => {
    saving = hook.result.current.save(changes);
    void hook.result.current.save(changes);
  });
  await waitFor(() => expect(patchConfig).toHaveBeenCalledTimes(1));
  await act(async () => {
    finishSave?.();
    await saving;
  });
  await waitFor(() => expect(hook.result.current.saveStatus).toBe("idle"));
  expect(patchConfig).toHaveBeenCalledWith({
    path: { assistant_id: "assistant-1" },
    body: changes,
  });
  expect(
    client.getQueryData<ConfigGetResponse>(configKey("assistant-1")),
  ).toEqual(savedConfig);
  expect(
    client.getQueryData<{ marker: string }>(configKey("assistant-2")),
  ).toEqual({
    marker: "other",
  });
  expect(onSaved).toHaveBeenCalledTimes(1);
});
test("save failure retains ready values and permits retry", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  saveFailure = true;
  await act(() => hook.result.current.save(changes));
  await waitFor(() => expect(hook.result.current.saveStatus).toBe("error"));
  expect(hook.result.current.state.status).toBe("ready");
  expect(onSaved).not.toHaveBeenCalled();
  saveFailure = false;
  await act(() => hook.result.current.save(changes));
  await waitFor(() => expect(hook.result.current.saveStatus).toBe("idle"));
  expect(onSaved).toHaveBeenCalledTimes(1);
});
test("late saves after unmount cannot restore old cache or close another modal", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  deferSave = true;
  let saving: Promise<void> | undefined;
  act(() => {
    saving = hook.result.current.save(changes);
  });
  await waitFor(() => expect(patchConfig).toHaveBeenCalledTimes(1));
  hook.unmount();
  client.clear();
  client.setQueryData(configKey("assistant-2"), { marker: "other" });
  await act(async () => {
    finishSave?.();
    await saving;
  });
  expect(
    client.getQueryData<ConfigGetResponse>(configKey("assistant-1")),
  ).toBeUndefined();
  expect(
    client.getQueryData<{ marker: string }>(configKey("assistant-2")),
  ).toEqual({
    marker: "other",
  });
  expect(onSaved).not.toHaveBeenCalled();
});
test("config invalidation refreshes values without hiding ready data", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  savedConfig = { ...savedConfig, notifications: { newMessageEnabled: false } };
  await act(() =>
    client.invalidateQueries({ queryKey: configKey("assistant-1") }),
  );
  await waitFor(() =>
    expect(hook.result.current.state).toMatchObject({
      status: "ready",
      values: { newMessageEnabled: false },
    }),
  );
  loadFailure = true;
  await act(() =>
    client.invalidateQueries({ queryKey: configKey("assistant-1") }),
  );
  expect(hook.result.current.state.status).toBe("ready");
});

test("organization changes block stale saves and responses before unmount", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  deferSave = true;
  let saving: Promise<void> | undefined;
  act(() => {
    saving = hook.result.current.save(changes);
  });
  await waitFor(() => expect(patchConfig).toHaveBeenCalledTimes(1));
  organizationId = "org-2";
  client.clear();
  await act(async () => {
    finishSave?.();
    await saving;
  });
  expect(
    client.getQueryData<ConfigGetResponse>(configKey("assistant-1")),
  ).toBeUndefined();
  expect(onSaved).not.toHaveBeenCalled();
  await act(() => hook.result.current.save(changes));
  expect(patchConfig).toHaveBeenCalledTimes(1);
});
