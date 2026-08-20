/**
 * Deleting a credential an LLM connection dispatches with must be refused
 * until the caller confirms, because losing it silently takes that connection
 * offline: the adapter keeps routing to the provider with no key and the turn
 * comes back empty.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { createConnection } from "../../../providers/inference/connections.js";
import { credentialKey } from "../../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../../../security/secure-keys.js";
import { CredentialInUseError } from "../credential-in-use.js";
import { ROUTES as CREDENTIAL_ROUTES } from "../credential-routes.js";
import { ROUTES as SECRET_ROUTES } from "../secret-routes.js";
import type { RouteDefinition } from "../types.js";

await initializeDb();

const SERVICE = "agentrouter";
const FIELD = "api_key";
const ACCOUNT = credentialKey(SERVICE, FIELD);

function findHandler(
  routes: RouteDefinition[],
  operationId: string,
): RouteDefinition["handler"] {
  const route = routes.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const deleteCredential = findHandler(CREDENTIAL_ROUTES, "credentials_delete");
const deleteSecret = findHandler(SECRET_ROUTES, "secrets_delete");

/** Run a handler and hand back whatever it rejected with, or null on success. */
async function rejection(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

/** Point an api_key connection at the credential under test. */
function createConnectionUsing(name: string, credential: string): void {
  const result = createConnection(getDb(), {
    name,
    provider: "openai",
    auth: { type: "api_key", credential },
  });
  if (!result.ok) {
    throw new Error(`Failed to create connection ${name}`);
  }
}

beforeEach(async () => {
  getDb().delete(providerConnections).run();
  await deleteSecureKeyAsync(ACCOUNT);
});

describe("credential delete in-use guard", () => {
  test("refuses a delete while a connection resolves auth through the credential", async () => {
    // GIVEN a stored credential
    await setSecureKeyAsync(ACCOUNT, "sk-test-value");

    // AND two LLM connections that dispatch with it
    createConnectionUsing("router-primary", `${SERVICE}:${FIELD}`);
    createConnectionUsing("router-fallback", ACCOUNT);

    // WHEN the credential is deleted without confirmation
    const error = await rejection(() =>
      deleteCredential({ body: { service: SERVICE, field: FIELD } }),
    );

    // THEN the delete is refused as a client error naming the connections
    expect(error).toBeInstanceOf(CredentialInUseError);
    const refusal = error as CredentialInUseError;
    expect(refusal.statusCode).toBe(400);
    expect(refusal.code).toBe("CREDENTIAL_IN_USE");
    expect(refusal.connections).toEqual(["router-fallback", "router-primary"]);
    expect(refusal.message).toContain("router-primary");

    // AND the credential is left in place, so those connections keep working
    expect(await getSecureKeyAsync(ACCOUNT)).toBe("sk-test-value");
  });

  test("deletes the credential when the caller confirms with force", async () => {
    // GIVEN a stored credential a connection dispatches with
    await setSecureKeyAsync(ACCOUNT, "sk-test-value");
    createConnectionUsing("router-primary", `${SERVICE}:${FIELD}`);

    // WHEN the delete is retried with force
    const result = await deleteCredential({
      body: { service: SERVICE, field: FIELD, force: true },
    });

    // THEN it succeeds and reports the connections it took offline
    expect(result).toMatchObject({
      service: SERVICE,
      field: FIELD,
      affectedConnections: ["router-primary"],
    });

    // AND the credential is gone from secure storage
    expect(await getSecureKeyAsync(ACCOUNT)).toBeUndefined();
  });

  test("deletes an unreferenced credential without confirmation", async () => {
    // GIVEN a stored credential no connection references
    await setSecureKeyAsync(ACCOUNT, "sk-test-value");
    createConnectionUsing("other-connection", "credential/openai/api_key");

    // WHEN it is deleted without force
    const result = await deleteCredential({
      body: { service: SERVICE, field: FIELD },
    });

    // THEN the delete goes through with no affected connections
    expect(result).toMatchObject({ affectedConnections: [] });
    expect(await getSecureKeyAsync(ACCOUNT)).toBeUndefined();
  });

  test("guards the api-key delete surface too", async () => {
    // GIVEN a provider API key a connection dispatches with
    const apiKeyAccount = credentialKey("openrouter", FIELD);
    await setSecureKeyAsync(apiKeyAccount, "sk-test-value");
    createConnectionUsing("router-primary", apiKeyAccount);

    // WHEN it is deleted through the secrets route without confirmation
    const error = await rejection(() =>
      deleteSecret({ body: { type: "api_key", name: "openrouter" } }),
    );

    // THEN the same refusal applies and the key survives
    expect(error).toBeInstanceOf(CredentialInUseError);
    expect((error as CredentialInUseError).connections).toEqual([
      "router-primary",
    ]);
    expect(await getSecureKeyAsync(apiKeyAccount)).toBe("sk-test-value");
    await deleteSecureKeyAsync(apiKeyAccount);
  });
});
