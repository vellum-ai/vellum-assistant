/**
 * The credentials page turns the daemon's refusal to delete an in-use
 * credential into a warning that names the connections it would take offline,
 * so a delete only goes through once the user has seen the cost.
 */

import { describe, expect, test } from "bun:test";

import { fixedT } from "@/i18n";
import { ApiError } from "@/utils/api-errors";

import {
  credentialInUseConnections,
  formatConnectionNames,
} from "./credential-in-use";

describe("credentialInUseConnections", () => {
  test("reads the dependent connections off a refused delete", () => {
    // GIVEN the daemon refused a delete because connections depend on the key
    const error = new ApiError(400, "Credential is in use", {
      code: "CREDENTIAL_IN_USE",
      details: { connections: ["router-primary", "router-fallback"] },
    });

    // WHEN the page inspects the failure
    const connections = credentialInUseConnections(error);

    // THEN it gets the connection names to warn about
    expect(connections).toEqual(["router-primary", "router-fallback"]);
  });

  test("ignores failures that are not an in-use refusal", () => {
    // GIVEN an unrelated daemon failure
    const error = new ApiError(500, "Boom", { code: "INTERNAL" });

    // WHEN the page inspects the failure
    const connections = credentialInUseConnections(error);

    // THEN there is nothing to confirm: it is reported as an error instead
    expect(connections).toBeNull();
  });

  test("ignores an in-use refusal without usable connection details", () => {
    // GIVEN an in-use refusal whose details are missing the connection list
    const error = new ApiError(400, "Credential is in use", {
      code: "CREDENTIAL_IN_USE",
      details: { connections: "router-primary" },
    });

    // WHEN the page inspects the failure
    const connections = credentialInUseConnections(error);

    // THEN it declines to invent a warning it cannot name connections in
    expect(connections).toBeNull();
  });
});

describe("the in-use warning", () => {
  const t = fixedT("settings");

  test("names the single connection a delete would take offline", () => {
    // GIVEN one connection depends on the credential
    const connections = ["router-primary"];

    // WHEN the warning is rendered for it
    const warning = t("credentialsPage.inUseMessage", {
      count: connections.length,
      name: "agentrouter:api_key",
      connections: formatConnectionNames(connections),
    });

    // THEN it names the credential and that connection in the singular
    expect(warning).toBe(
      "agentrouter:api_key is the credential that the connection router-primary uses to send requests. Deleting it stops that connection from answering until you add a new credential.",
    );
  });

  test("names every connection a delete would take offline", () => {
    // GIVEN two connections depend on the credential
    const connections = ["router-primary", "router-fallback"];

    // WHEN the warning is rendered for them
    const warning = t("credentialsPage.inUseMessage", {
      count: connections.length,
      name: "agentrouter:api_key",
      connections: formatConnectionNames(connections),
    });

    // THEN both are named as a list, in the plural
    expect(warning).toBe(
      "agentrouter:api_key is the credential that the connections router-primary and router-fallback use to send requests. Deleting it stops those connections from answering until you add a new credential.",
    );
  });
});
