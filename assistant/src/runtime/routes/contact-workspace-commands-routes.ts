/**
 * Contact workspace-commands grants.
 *
 * GET/PUT /v1/contacts/:id/workspace-commands
 * CLI variants take a contact id.
 */

import { z } from "zod";

import {
  contactWorkspaceCommandsEnabled,
  disableContactWorkspaceCommands,
  upsertContactToolGrants,
} from "../../approvals/contact-tool-grant.js";
import { getContact } from "../../contacts/contact-store.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const workspaceCommandsResponseSchema = z.object({
  contactId: z.string(),
  enabled: z.boolean(),
});

function requireContact(contactId: string): string {
  const trimmed = contactId.trim();
  if (!trimmed) {
    throw new BadRequestError("contactId is required.");
  }
  const contact = getContact(trimmed);
  if (!contact) {
    throw new NotFoundError(`Contact ${trimmed} not found`);
  }
  return contact.id;
}

function readWorkspaceCommands(contactId: string): {
  contactId: string;
  enabled: boolean;
} {
  return {
    contactId,
    enabled: contactWorkspaceCommandsEnabled(contactId),
  };
}

function writeWorkspaceCommands(
  contactId: string,
  enabled: boolean,
  requestChannel: string,
): {
  contactId: string;
  enabled: boolean;
} {
  if (enabled) {
    try {
      upsertContactToolGrants({
        contactId,
        requestChannel,
        decisionChannel: requestChannel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestError(message);
    }
  } else {
    disableContactWorkspaceCommands(contactId);
  }
  return readWorkspaceCommands(contactId);
}

function contactIdFromBody(body: Record<string, unknown>): string {
  const contactId =
    typeof body.contactId === "string" ? body.contactId.trim() : "";
  if (!contactId) {
    throw new BadRequestError("contactId is required.");
  }
  return requireContact(contactId);
}

function handleGetWorkspaceCommands({ pathParams = {} }: RouteHandlerArgs) {
  return readWorkspaceCommands(requireContact(pathParams.id!));
}

function handleSetWorkspaceCommands({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  if (typeof body.enabled !== "boolean") {
    throw new BadRequestError("enabled must be a boolean");
  }
  return writeWorkspaceCommands(
    requireContact(pathParams.id!),
    body.enabled,
    "http",
  );
}

function handleGetWorkspaceCommandsCli({ body = {} }: RouteHandlerArgs) {
  return readWorkspaceCommands(contactIdFromBody(body));
}

function handleSetWorkspaceCommandsCli({ body = {} }: RouteHandlerArgs) {
  if (typeof body.enabled !== "boolean") {
    throw new BadRequestError("enabled must be a boolean");
  }
  return writeWorkspaceCommands(
    contactIdFromBody(body),
    body.enabled,
    "cli",
  );
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getContactWorkspaceCommands",
    endpoint: "contacts/:id/workspace-commands",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    pathParams: [{ name: "id", type: "string" }],
    summary: "Get workspace commands for a contact",
    description:
      "Whether this trusted contact may run workspace shell commands without a per-command approval.",
    tags: ["contacts"],
    responseBody: workspaceCommandsResponseSchema,
    handler: handleGetWorkspaceCommands,
  },
  {
    operationId: "setContactWorkspaceCommands",
    endpoint: "contacts/:id/workspace-commands",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    pathParams: [{ name: "id", type: "string" }],
    summary: "Set workspace commands for a contact",
    description:
      "Enable or disable standing workspace shell access for a trusted contact. High-risk commands still require approval.",
    tags: ["contacts"],
    requestBody: z.object({
      enabled: z.boolean(),
    }),
    responseBody: workspaceCommandsResponseSchema,
    handler: handleSetWorkspaceCommands,
  },
  {
    operationId: "contact_workspace_commands_get_cli",
    endpoint: "contacts/cli/workspace-commands/get",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Get workspace commands for a contact (CLI)",
    description:
      "Look up standing workspace-command access by contact ID.",
    tags: ["contacts"],
    requestBody: z.object({
      contactId: z.string(),
    }),
    responseBody: workspaceCommandsResponseSchema,
    handler: handleGetWorkspaceCommandsCli,
  },
  {
    operationId: "contact_workspace_commands_set_cli",
    endpoint: "contacts/cli/workspace-commands/set",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Set workspace commands for a contact (CLI)",
    description:
      "Enable or disable standing workspace-command access by contact ID.",
    tags: ["contacts"],
    requestBody: z.object({
      contactId: z.string(),
      enabled: z.boolean(),
    }),
    responseBody: workspaceCommandsResponseSchema,
    handler: handleSetWorkspaceCommandsCli,
  },
];
