import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { ReactNode } from "react";

import { GOOGLE_MANAGED_FULL_CONNECT_SCOPES } from "@/lib/auth/google-oauth-scopes";

const startOAuthMutateMock = mock(
  (_variables: unknown, _callbacks?: unknown) => undefined,
);
const resolveLocalAssistantPlatformIdentityMock = mock(
  async (assistantId: string) => `platform-${assistantId}`,
);
const useIsNativePlatformMock = mock(() => false);
const openUrlMock = mock(async (_url: string) => undefined);
const openUrlFinishedListenerMock = mock((_callback: () => void) => () => {});

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsOauthConnectionsListOptions: (options: unknown) => ({
    queryKey: ["assistantsOauthConnectionsList", options],
    queryFn: async () => [],
  }),
  useAssistantsOauthStartCreateMutation: () => ({
    isPending: false,
    mutate: startOAuthMutateMock,
  }),
}));

mock.module("@/lib/local-platform-identity", () => ({
  resolveLocalAssistantPlatformIdentity:
    resolveLocalAssistantPlatformIdentityMock,
}));

mock.module("@/runtime/browser", () => ({
  openUrl: openUrlMock,
  openUrlFinishedListener: openUrlFinishedListenerMock,
}));

mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: useIsNativePlatformMock,
}));

const { GoogleConnectScreen } = await import(
  "@/domains/onboarding/screens/google-connect-screen"
);
const { useOAuthConnect } = await import("@/hooks/use-oauth-connect");

let originalWindowOpen: typeof window.open;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function installPopupWindowMock() {
  const popup = {
    closed: false,
    close: mock(() => {
      popup.closed = true;
    }),
    location: { href: "" },
  };

  Object.defineProperty(window, "open", {
    configurable: true,
    value: mock(() => popup as unknown as Window),
  });
}

function firstStartOAuthVariables() {
  return startOAuthMutateMock.mock.calls[0]?.[0] as {
    body: { requested_scopes: string[]; redirect_after_connect: string };
    path: { assistant_id: string; provider: string };
  };
}

beforeEach(() => {
  originalWindowOpen = window.open;
  installPopupWindowMock();
  startOAuthMutateMock.mockClear();
  resolveLocalAssistantPlatformIdentityMock.mockClear();
  resolveLocalAssistantPlatformIdentityMock.mockImplementation(
    async (assistantId: string) => `platform-${assistantId}`,
  );
  useIsNativePlatformMock.mockClear();
  useIsNativePlatformMock.mockImplementation(() => false);
  openUrlMock.mockClear();
  openUrlFinishedListenerMock.mockClear();
  openUrlFinishedListenerMock.mockImplementation(() => () => {});
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "open", {
    configurable: true,
    value: originalWindowOpen,
  });
});

describe("managed Google OAuth request scopes", () => {
  test("settings full Google connect starts OAuth with explicit managed scopes", async () => {
    const { result } = renderHook(
      () =>
        useOAuthConnect({
          allConnections: [],
          assistantId: "asst-1",
          connectionsQueryKey: ["connections"],
          displayName: "Google",
          managedAvailable: true,
          providerKey: "google",
        }),
      { wrapper: createWrapper() },
    );

    act(() => result.current.handleConnect());

    await waitFor(() => {
      expect(startOAuthMutateMock).toHaveBeenCalledTimes(1);
    });
    expect(firstStartOAuthVariables()).toMatchObject({
      body: {
        requested_scopes: [...GOOGLE_MANAGED_FULL_CONNECT_SCOPES],
      },
      path: { assistant_id: "platform-asst-1", provider: "google" },
    });
  });

  test("settings scoped Google connect preserves the requested subset", async () => {
    const requestedScopes = [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/calendar.events",
    ];
    const { result } = renderHook(
      () =>
        useOAuthConnect({
          allConnections: [],
          assistantId: "asst-1",
          connectionsQueryKey: ["connections"],
          displayName: "Google",
          managedAvailable: true,
          providerKey: "google",
        }),
      { wrapper: createWrapper() },
    );

    act(() => result.current.handleConnect(requestedScopes));

    await waitFor(() => {
      expect(startOAuthMutateMock).toHaveBeenCalledTimes(1);
    });
    expect(firstStartOAuthVariables().body.requested_scopes).toEqual(
      requestedScopes,
    );
  });

  test("onboarding Google connect starts OAuth with explicit managed scopes", async () => {
    render(
      <GoogleConnectScreen
        assistantId="asst-1"
        assistantName="Example Assistant"
        onBack={() => undefined}
        onConnect={() => undefined}
        onSkip={() => undefined}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect Google" }));

    await waitFor(() => {
      expect(startOAuthMutateMock).toHaveBeenCalledTimes(1);
    });
    expect(firstStartOAuthVariables()).toMatchObject({
      body: {
        requested_scopes: [...GOOGLE_MANAGED_FULL_CONNECT_SCOPES],
      },
      path: { assistant_id: "platform-asst-1", provider: "google" },
    });
  });
});
