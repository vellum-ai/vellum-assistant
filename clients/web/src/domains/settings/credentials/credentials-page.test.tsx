import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

let developerMode = false;
let ownCredentials: Array<{ service: string; field: string }> = [];
let managedCredentials: Array<{
  handle: string;
  provider: string;
  accountInfo: string | null;
  status: string;
}> = [];

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-123",
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

mock.module("@/lib/backwards-compat/use-supports-credentials-settings", () => ({
  useSupportsCredentialsSettings: () => true,
}));

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    settingsDeveloperNav: () => developerMode,
  };
  return { useAssistantFeatureFlagStore: store };
});

mock.module("@/stores/assistant-identity-store", () => {
  const store = () => null;
  store.use = {
    assistantId: () => "assistant-123",
    version: () => "0.11.0",
  };
  return { useAssistantIdentityStore: store };
});

mock.module("@/generated/daemon/sdk.gen", () => ({
  credentialsListPost: async () => ({
    data: { credentials: ownCredentials, managedCredentials },
  }),
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  useCredentialsDeletePostMutation: () => ({
    mutate: () => {},
    isPending: false,
    variables: undefined,
  }),
}));

mock.module("@/components/add-credential-modal", () => ({
  AddCredentialModal: () => null,
  credentialsListQueryKey: (assistantId: string) => [
    "credentials",
    assistantId,
  ],
}));

mock.module("./credential-row", () => ({
  CredentialRow: ({
    credential,
  }: {
    credential: { service: string; field: string };
  }) => <div>{`${credential.service}:${credential.field}`}</div>,
}));

const { CredentialsPage } = await import("./credentials-page");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  developerMode = false;
  ownCredentials = [];
  managedCredentials = [];
});

describe("CredentialsPage", () => {
  test("hides managed credentials and the source split outside developer mode", async () => {
    ownCredentials = [{ service: "stripe", field: "api_key" }];
    managedCredentials = [
      {
        handle: "managed-google",
        provider: "Google",
        accountInfo: "user@example.com",
        status: "connected",
      },
    ];

    render(<CredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText("stripe:api_key")).not.toBeNull();
    });
    expect(screen.queryByLabelText("Credential source")).toBeNull();
    expect(screen.queryByText("Google")).toBeNull();
  });

  test("shows the source split and managed credentials in developer mode", async () => {
    developerMode = true;
    ownCredentials = [{ service: "stripe", field: "api_key" }];
    managedCredentials = [
      {
        handle: "managed-google",
        provider: "Google",
        accountInfo: "user@example.com",
        status: "connected",
      },
    ];

    render(<CredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByLabelText("Credential source")).not.toBeNull();
    });
    expect(screen.getByText("stripe:api_key")).not.toBeNull();
  });

  test("shows the empty state instead of managed credentials outside developer mode", async () => {
    managedCredentials = [
      {
        handle: "managed-google",
        provider: "Google",
        accountInfo: "user@example.com",
        status: "connected",
      },
    ];

    render(<CredentialsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText("No credentials yet")).not.toBeNull();
    });
    expect(screen.queryByLabelText("Credential source")).toBeNull();
    expect(screen.queryByText("Google")).toBeNull();
  });
});
