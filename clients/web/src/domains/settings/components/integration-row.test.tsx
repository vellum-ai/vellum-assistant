import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { OAuthConnection } from "@/generated/api/types.gen";

import { IntegrationRow } from "./integration-row";

function connection(id: string, connected: boolean): OAuthConnection {
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

describe("IntegrationRow", () => {
  test("aggregates active accounts and opens exact account management", () => {
    const configure = mock(() => {});
    render(
      <IntegrationRow
        providerKey="example"
        displayName="Example Integration"
        description="Example description"
        logoUrl={null}
        connections={[
          connection("account-1", true),
          connection("account-2", false),
        ]}
        onConfigure={configure}
      />,
    );

    screen.getByText("1 connected account");
    screen.getByText("Connected");
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(configure).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  test("keeps a saved inactive account in recovery state", () => {
    render(
      <IntegrationRow
        providerKey="example"
        displayName="Example Integration"
        description="Example description"
        logoUrl={null}
        connections={[connection("account-1", false)]}
        onConfigure={() => {}}
      />,
    );

    screen.getByText("Needs attention");
    screen.getByRole("button", { name: "Configure" });
  });

  test("offers Connect for an available provider", () => {
    render(
      <IntegrationRow
        providerKey="example"
        displayName="Example Integration"
        description="Example description"
        logoUrl={null}
        connections={[]}
        layout="tile"
        onConfigure={() => {}}
      />,
    );

    screen.getByText("Example description");
    screen.getByRole("button", { name: "Connect" });
  });
});
