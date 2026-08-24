import { beforeEach, describe, expect, test } from "bun:test";

import { upsertContact } from "../../../contacts/contact-store.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { ROUTES } from "../contact-workspace-commands-routes.js";
import type { RouteDefinition } from "../types.js";

await initializeDb();

function findHandler(operationId: string) {
  const route = ROUTES.find((r: RouteDefinition) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const getHandler = findHandler("getContactWorkspaceCommands");
const putHandler = findHandler("setContactWorkspaceCommands");
const getCliHandler = findHandler("contact_workspace_commands_get_cli");
const setCliHandler = findHandler("contact_workspace_commands_set_cli");

function seedContact(id: string, address: string): void {
  upsertContact({
    id,
    displayName: "Alice",
    channels: [{ type: "slack", address }],
  });
}

function clear(): void {
  getDb().run("DELETE FROM scoped_approval_grants");
  getDb().run("DELETE FROM contact_channels");
  getDb().run("DELETE FROM contacts");
}

describe("contact workspace-commands routes", () => {
  beforeEach(() => {
    clear();
    seedContact("contact-abc", "U12345678");
  });

  test("GET reports disabled until a standing grant is written", async () => {
    const before = await getHandler({ pathParams: { id: "contact-abc" } });
    expect(before).toEqual({ contactId: "contact-abc", enabled: false });

    const after = await putHandler({
      pathParams: { id: "contact-abc" },
      body: { enabled: true },
    });
    expect(after).toEqual({ contactId: "contact-abc", enabled: true });

    const reread = await getHandler({ pathParams: { id: "contact-abc" } });
    expect(reread).toEqual({ contactId: "contact-abc", enabled: true });
  });

  test("PUT enabled false revokes the standing grant", async () => {
    await putHandler({
      pathParams: { id: "contact-abc" },
      body: { enabled: true },
    });
    const denied = await putHandler({
      pathParams: { id: "contact-abc" },
      body: { enabled: false },
    });
    expect(denied).toEqual({ contactId: "contact-abc", enabled: false });
  });

  test("CLI allow writes a standing grant for the contact", async () => {
    const result = await setCliHandler({
      body: { contactId: "contact-abc", enabled: true },
    });
    expect(result).toEqual({ contactId: "contact-abc", enabled: true });

    const status = await getCliHandler({
      body: { contactId: "contact-abc" },
    });
    expect(status).toEqual({ contactId: "contact-abc", enabled: true });
  });

  test("CLI rejects a missing contact id", () => {
    expect(() => getCliHandler({ body: {} })).toThrow("contactId is required");
  });
});
