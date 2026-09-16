import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { OAuthConnection } from "@/generated/api/types.gen";

import { ManagedTab } from "./managed-oauth-tab";

function connection(
  id: string,
  connected: boolean,
): OAuthConnection {
  return {
    id,
    provider: "notion",
    status: connected ? "ACTIVE" : "ERROR",
    connected,
    account_label: `${id}@example.com`,
    scopes_granted: [],
    expires_at: null,
  };
}

afterEach(cleanup);

describe("ManagedTab", () => {
  test("shows mixed account status and removes the selected exact account", () => {
    const active = connection("active-account", true);
    const inactive = connection("inactive-account", false);
    const disconnect = mock(() => {});
    render(
      <ManagedTab
        displayName="Notion"
        providerKey="notion"
        logoUrl={null}
        connections={[active, inactive]}
        connectionsLoading={false}
        oauthInProgress={false}
        onCancelConnect={() => {}}
        disconnectingId={null}
        onConnect={() => {}}
        onDisconnect={disconnect}
      />,
    );

    screen.getByText("active-account@example.com");
    screen.getByText("inactive-account@example.com");
    screen.getByText("Connected");
    screen.getByText("Needs attention");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Disconnect inactive-account@example.com",
      }),
    );
    expect(disconnect).toHaveBeenCalledWith(inactive);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test("keeps an inactive-only account removable", () => {
    const inactive = connection("inactive-account", false);
    const disconnect = mock(() => {});
    render(
      <ManagedTab
        displayName="Notion"
        providerKey="notion"
        logoUrl={null}
        connections={[inactive]}
        connectionsLoading={false}
        oauthInProgress={false}
        onCancelConnect={() => {}}
        disconnectingId={null}
        onConnect={() => {}}
        onDisconnect={disconnect}
      />,
    );

    screen.getByText("Needs attention");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Disconnect inactive-account@example.com",
      }),
    );
    expect(disconnect).toHaveBeenCalledWith(inactive);
  });
});
