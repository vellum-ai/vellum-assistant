import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import { ApiError } from "@/utils/api-errors";

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

interface DeleteBody {
  service: string;
  field: string;
  force?: boolean;
}

let deleteBodies: DeleteBody[] = [];
/** When set, the next delete fails with this error instead of succeeding. */
let deleteError: Error | null = null;

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  useCredentialsDeletePostMutation: (options?: {
    onSuccess?: (data: unknown, variables: { body: DeleteBody }) => void;
    onError?: (error: Error, variables: { body: DeleteBody }) => void;
  }) => ({
    mutate: (variables: { body: DeleteBody }) => {
      deleteBodies.push(variables.body);
      if (deleteError) {
        options?.onError?.(deleteError, variables);
        return;
      }
      options?.onSuccess?.(undefined, variables);
    },
    isPending: false,
    variables: undefined,
  }),
}));

const capturedErrors: unknown[] = [];
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: (error: unknown) => {
    capturedErrors.push(error);
  },
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
    onDelete,
  }: {
    credential: { service: string; field: string };
    onDelete: () => void;
  }) => {
    const name = `${credential.service}:${credential.field}`;
    return (
      <div>
        {name}
        <button type="button" onClick={onDelete}>{`Delete ${name}`}</button>
      </div>
    );
  },
}));

function credentialInUseError(connections: string[]): Error {
  return new ApiError(400, "Credential is in use", {
    code: "CREDENTIAL_IN_USE",
    details: { connections },
  });
}

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
  deleteBodies = [];
  deleteError = null;
  capturedErrors.length = 0;
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

  test("deletes without force once the first confirmation is accepted", async () => {
    // GIVEN a stored credential no connection depends on
    ownCredentials = [{ service: "agentrouter", field: "api_key" }];
    render(<CredentialsPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("Delete agentrouter:api_key")).not.toBeNull();
    });

    // WHEN the user confirms the delete
    await userEvent.click(screen.getByText("Delete agentrouter:api_key"));
    await screen.findByText("Delete credential");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    // THEN the daemon decides whether the credential is in use, so the first
    // attempt never carries force
    expect(deleteBodies).toEqual([
      { service: "agentrouter", field: "api_key" },
    ]);
  });

  test("warns with the dependent connections and retries with force only on confirmation", async () => {
    // GIVEN a credential two provider connections dispatch through
    ownCredentials = [{ service: "agentrouter", field: "api_key" }];
    deleteError = credentialInUseError(["router-primary", "router-fallback"]);
    render(<CredentialsPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("Delete agentrouter:api_key")).not.toBeNull();
    });

    // WHEN the refused delete comes back from the daemon
    await userEvent.click(screen.getByText("Delete agentrouter:api_key"));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    // THEN the warning names every connection the delete would break, and the
    // refusal is not reported as an unexpected failure
    const warning = await screen.findByText(/router-primary and router-fallback/);
    expect(warning.textContent).toContain("agentrouter:api_key");
    expect(capturedErrors).toEqual([]);

    // WHEN the user backs out
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // THEN nothing further is sent
    await waitFor(() => {
      expect(screen.queryByText(/router-primary and router-fallback/)).toBeNull();
    });
    expect(deleteBodies).toHaveLength(1);

    // WHEN the user asks again and accepts the consequences
    await userEvent.click(screen.getByText("Delete agentrouter:api_key"));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText(/router-primary and router-fallback/);
    deleteError = null;
    await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));

    // THEN only that explicit confirmation forces the delete
    expect(deleteBodies[1]).toEqual({
      service: "agentrouter",
      field: "api_key",
    });
    expect(deleteBodies[2]).toEqual({
      service: "agentrouter",
      field: "api_key",
      force: true,
    });
  });

  test("reports an unexpected delete failure instead of warning about connections", async () => {
    // GIVEN a delete that fails for a reason unrelated to connection usage
    ownCredentials = [{ service: "agentrouter", field: "api_key" }];
    deleteError = new Error("secure storage unavailable");
    render(<CredentialsPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByText("Delete agentrouter:api_key")).not.toBeNull();
    });

    // WHEN the user confirms the delete
    await userEvent.click(screen.getByText("Delete agentrouter:api_key"));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    // THEN the failure is reported rather than presented as an in-use warning
    expect(capturedErrors).toEqual([deleteError]);
    expect(screen.queryByText("Credential is in use")).toBeNull();
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
