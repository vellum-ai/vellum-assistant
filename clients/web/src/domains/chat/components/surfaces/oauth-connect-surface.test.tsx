import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

// Keep the platform-id resolution deterministic: the surface resolves the
// assistant's platform id before invalidating the connections query, and the
// real resolver reaches into local-mode/gateway state.
mock.module("@/lib/local-platform-identity", () => ({
  resolveLocalAssistantPlatformIdentity: mock(async (id: string) => id),
}));

import { OAuthConnectSurface } from "@/domains/chat/components/surfaces/oauth-connect-surface";
import type {
  ManagedOAuthConnectClient,
  ManagedOAuthConnectOptions,
  ManagedOAuthConnectResult,
} from "@/domains/chat/api/managed-oauth";
import type { OAuthConnection } from "@/generated/api/types.gen";
import type { Surface } from "@/domains/chat/types/types";

afterAll(() => {
  mock.restore();
});

afterEach(() => {
  cleanup();
});

// The surface reads `useQueryClient()` to refresh the connections list after a
// successful connect, so its renders need a provider. The invalidation itself
// is stubbed out; this file only exercises the connect-args and action wiring.
function renderWithQueryClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.invalidateQueries = mock(() => Promise.resolve()) as never;
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeSurface(data: Record<string, unknown>): Surface {
  return {
    surfaceId: "surface-1",
    surfaceType: "oauth_connect",
    data,
  };
}

function makeConnectedResult(
  scopesGranted: string[],
): ManagedOAuthConnectResult {
  return {
    status: "connected",
    connection: {
      id: "conn-1",
      provider: "google",
      status: "ACTIVE",
      connected: true,
      account_label: "user@example.com",
      scopes_granted: scopesGranted,
      expires_at: null,
    } as OAuthConnection,
  };
}

describe("OAuthConnectSurface requested scopes", () => {
  test("forwards the surface's requestedScopes to the connect flow", async () => {
    const oauthClient: ManagedOAuthConnectClient = {
      fetchProvider: mock(async () => null),
      connect: mock(async () =>
        makeConnectedResult(["gmail.readonly", "tasks"]),
      ),
    };

    const { getByRole } = renderWithQueryClient(
      <OAuthConnectSurface
        surface={makeSurface({
          providerKey: "google",
          displayName: "Google",
          requestedScopes: ["gmail.readonly", "tasks"],
        })}
        assistantId="assistant-1"
        oauthClient={oauthClient}
        onAction={mock(() => {})}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(oauthClient.connect).toHaveBeenCalledWith({
        assistantId: "assistant-1",
        providerKey: "google",
        providerLabel: "Google",
        requestedScopes: ["gmail.readonly", "tasks"],
      });
    });
  });

  test("omits requestedScopes when the surface data carries none", async () => {
    const connect = mock(async (_options: ManagedOAuthConnectOptions) =>
      makeConnectedResult([]),
    );
    const oauthClient: ManagedOAuthConnectClient = {
      fetchProvider: mock(async () => null),
      connect,
    };

    const { getByRole } = renderWithQueryClient(
      <OAuthConnectSurface
        surface={makeSurface({
          providerKey: "google",
          displayName: "Google",
        })}
        assistantId="assistant-1"
        oauthClient={oauthClient}
        onAction={mock(() => {})}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(connect.mock.calls[0]?.[0]?.requestedScopes).toBeUndefined();
  });

  test("reports scopesGranted from the resulting connection, not the request", async () => {
    // The platform decides what was actually granted; the action payload must
    // reflect the connection's scopes_granted so the model can verify the
    // grant includes what it asked for.
    const onAction = mock(() => {});
    const oauthClient: ManagedOAuthConnectClient = {
      fetchProvider: mock(async () => null),
      connect: mock(async () =>
        makeConnectedResult(["gmail.readonly", "tasks", "calendar"]),
      ),
    };

    const { getByRole } = renderWithQueryClient(
      <OAuthConnectSurface
        surface={makeSurface({
          providerKey: "google",
          displayName: "Google",
          requestedScopes: ["tasks"],
        })}
        assistantId="assistant-1"
        oauthClient={oauthClient}
        onAction={onAction}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith("surface-1", "connect", {
        status: "connected",
        providerKey: "google",
        providerLabel: "Google",
        connectionId: "conn-1",
        accountLabel: "user@example.com",
        scopesGranted: ["gmail.readonly", "tasks", "calendar"],
      });
    });
  });
});
