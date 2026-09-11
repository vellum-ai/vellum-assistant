import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { IntegrationConfigureMenu } from "./integration-row";

afterEach(cleanup);

test("OAuth Configure exposes connection settings and a named disconnect action", async () => {
  const edit = mock(() => {});
  const disconnect = mock(() => {});
  const { rerender } = render(<IntegrationConfigureMenu
    displayName="Example Integration" open onOpenChange={() => {}}
    onEditConnections={edit} onDisable={disconnect} disablePending={false}
  />);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit connections" }));
  expect(edit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
  expect(disconnect).toHaveBeenCalledTimes(1);

  rerender(<IntegrationConfigureMenu
    displayName="Example Integration" open onOpenChange={() => {}}
    onEditConnections={edit} onDisable={disconnect} disablePending
  />);
  expect(screen.getByRole("menuitem", { name: "Disconnect" }).getAttribute("data-disabled")).not.toBeNull();
});
