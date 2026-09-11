import { expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { oauthConnection } from "../integration-test-fixtures";

const accounts = [
  oauthConnection({
    id: "failed-account",
    account_label: "Example expired account",
    connected: false,
  }),
  oauthConnection({
    id: "working-account",
    account_label: "Example working account",
  }),
];
const disconnect = mock(() => {});
const actualQueries = await import("@/generated/api/@tanstack/react-query.gen");
mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  ...actualQueries,
  assistantsOauthConnectionsListOptions: () => ({
    queryKey: ["oauth-test-accounts"],
    queryFn: async () => accounts,
  }),
  useAssistantsOauthDisconnectByConnectionCreateMutation: () => ({
    mutate: disconnect,
    isPending: false,
  }),
}));
mock.module("@/hooks/use-managed-oauth-connect", () => ({
  useManagedOAuthConnect: () => ({
    status: "idle",
    connect: () => {},
    dismiss: () => {},
    errorMessage: null,
  }),
}));
const actualGate = await import("@/hooks/use-platform-gate");
mock.module("@/hooks/use-platform-gate", () => ({
  ...actualGate,
  useActiveAssistantIsPlatformHosted: () => true,
}));
mock.module("./your-own-oauth-tab", () => ({ YourOwnTab: () => null }));
const { IntegrationDetailModal } = await import("./integration-detail-modal");

test("Configure preserves failed and working accounts and disconnects only the confirmed account", async () => {
  const client = new QueryClient();
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <IntegrationDetailModal
        assistantId="local-assistant"
        platformAssistantId="platform-assistant"
        providerKey="notion"
        displayName="Notion"
        description={null}
        logoUrl={null}
        platformGate="full"
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
  await screen.findByText("Example expired account");
  screen.getByText("Example working account");
  screen.getByText("Needs attention");
  fireEvent.click(
    screen.getByRole("button", { name: "Disconnect Example expired account" }),
  );
  expect(disconnect).not.toHaveBeenCalled();
  screen.getByText(/Disconnect Example expired account/);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(disconnect).toHaveBeenCalledWith({
    path: {
      assistant_id: "platform-assistant",
      connection_id: "failed-account",
    },
  });
  expect(disconnect).toHaveBeenCalledTimes(1);
  unmount();
  client.clear();
});
