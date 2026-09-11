import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { oauthConnection } from "../integration-test-fixtures";
import { IntegrationRow } from "./integration-row";

afterEach(cleanup);

test("OAuth row configures all accounts when a second account remains connected", () => {
  const configure = mock(() => {});
  render(
    <IntegrationRow
      providerKey="notion"
      displayName="Notion"
      description={null}
      logoUrl={null}
      connections={[
        oauthConnection({ connected: false, status: "ERROR" }),
        oauthConnection({ id: "connection-2" }),
      ]}
      onConfigure={configure}
    />,
  );
  screen.getByText("Connected");
  screen.getByText("1 connected account");
  fireEvent.click(screen.getByRole("button", { name: "Configure" }));
  expect(configure).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
});

test("OAuth row without an account offers Connect", () => {
  render(
    <IntegrationRow
      providerKey="notion"
      displayName="Notion"
      description={null}
      logoUrl={null}
      connections={[]}
      onConfigure={() => {}}
    />,
  );
  screen.getByRole("button", { name: "Connect" });
});
