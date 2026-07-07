/**
 * Transport-agnostic route for securely prompting the user for a credential.
 *
 * CLI commands and skill scripts call this route to trigger a secure input
 * prompt in the user's app. The handler sends the prompt to connected
 * clients, stores the credential and its metadata on success.
 */

import { z } from "zod";

import {
  formatSlackChannelStatus,
  persistPromptedCredential,
} from "../../credential-execution/prompted-credential.js";
import { requestSecretStandalone } from "../../daemon/handlers/shared.js";
import {
  assertMetadataWritable,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const InjectionTemplateSchema = z.object({
  hostPattern: z.string().min(1),
  injectionType: z.enum(["header", "query"]),
  headerName: z.string().optional(),
  valuePrefix: z.string().optional(),
  queryParamName: z.string().optional(),
});

const CredentialPromptParams = z.object({
  service: z.string().min(1),
  field: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  usageDescription: z.string().optional(),
  allowedDomains: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  injectionTemplates: z.array(InjectionTemplateSchema).optional(),
  conversationId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Response type (shared with CLI consumer)
// ---------------------------------------------------------------------------

export type CredentialPromptResult = {
  ok: boolean;
  /**
   * True when the user explicitly dismissed the secure prompt. This is a valid
   * outcome, not a failure — the CLI surfaces it as an informational message
   * and a distinct exit code rather than an error.
   */
  cancelled?: boolean;
  /**
   * True when no value was collected yet but a one-time collection link was
   * minted (channel without secure input). `collectionUrl` carries the link;
   * the value is stored by the gateway when the recipient submits it.
   */
  pending?: boolean;
  collectionUrl?: string;
  expiresAt?: number;
  error?: string;
  service?: string;
  field?: string;
  message?: string;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleCredentialPrompt({ body = {} }: RouteHandlerArgs) {
  const validated = CredentialPromptParams.parse(body);

  assertMetadataWritable();

  const result = await requestSecretStandalone({
    service: validated.service,
    field: validated.field,
    label: validated.label,
    description: validated.description,
    placeholder: validated.placeholder,
    purpose: validated.usageDescription,
    allowedTools: validated.allowedTools,
    allowedDomains: validated.allowedDomains,
    conversationId: validated.conversationId,
  });

  if (!result.value) {
    if (result.error === "unsupported_channel") {
      if (result.collectionUrl) {
        // The channel cannot render the secure prompt, but a one-time
        // collection link was minted instead. Attach the policy metadata now —
        // the gateway submit stores the value via credentials_set, which
        // leaves these metadata fields untouched.
        try {
          upsertCredentialMetadata(validated.service, validated.field, {
            allowedTools: validated.allowedTools,
            allowedDomains: validated.allowedDomains,
            usageDescription: validated.usageDescription,
            injectionTemplates: validated.injectionTemplates,
          });
        } catch {
          // Best-effort: the submit path still stores the value without it.
        }
        const expiresInMinutes = result.collectionExpiresAt
          ? Math.max(
              1,
              Math.round((result.collectionExpiresAt - Date.now()) / 60_000),
            )
          : null;
        return {
          ok: true,
          pending: true,
          collectionUrl: result.collectionUrl,
          expiresAt: result.collectionExpiresAt,
          service: validated.service,
          field: validated.field,
          message: `This channel does not support secure input. Share this one-time link with the user to collect the credential securely (single-use${expiresInMinutes ? `, expires in ${expiresInMinutes} minutes` : ""}): ${result.collectionUrl}`,
        };
      }
      return {
        ok: false,
        error:
          "This conversation's channel does not support secure credential entry",
      };
    }
    // An explicit user cancel is a valid flow, not a failure. Keep it distinct
    // from a timeout (no response in the permission window) and a supersession
    // (a newer message auto-denied the pending prompt) so the CLI exits with
    // the user-interrupt convention only for real cancels.
    if (result.reason === "timed_out") {
      return { ok: false, error: "The credential prompt timed out" };
    }
    if (result.reason === "superseded") {
      return {
        ok: false,
        error: "The credential prompt was superseded by a new message",
      };
    }
    return { ok: false, cancelled: true, error: "Cancelled by the user" };
  }

  const persisted = await persistPromptedCredential({
    service: validated.service,
    field: validated.field,
    value: result.value,
    delivery: result.delivery,
    policy: {
      allowedTools: validated.allowedTools,
      allowedDomains: validated.allowedDomains,
      usageDescription: validated.usageDescription,
      injectionTemplates: validated.injectionTemplates,
    },
  });

  if (persisted.outcome === "error") {
    return { ok: false, error: persisted.message };
  }

  if (persisted.outcome === "transient") {
    return {
      ok: true,
      service: validated.service,
      field: validated.field,
      message: `One-time credential provided for ${validated.service}/${validated.field}. The value was not saved and will be consumed by the next operation.`,
    };
  }

  const slackStatus = persisted.slackChannel
    ? formatSlackChannelStatus(persisted.slackChannel).trim()
    : "";

  return {
    ok: true,
    service: validated.service,
    field: validated.field,
    message: slackStatus.length > 0 ? slackStatus : undefined,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "credentials_prompt",
    endpoint: "credentials/prompt",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleCredentialPrompt,
    summary: "Prompt user for a credential",
    description:
      "Trigger a secure input prompt in the user's app to collect a credential value.",
    tags: ["credentials"],
    requestBody: CredentialPromptParams,
    responseBody: z.object({
      ok: z.boolean(),
      cancelled: z.boolean().optional(),
      pending: z.boolean().optional(),
      collectionUrl: z.string().optional(),
      expiresAt: z.number().optional(),
      error: z.string().optional(),
      service: z.string().optional(),
      field: z.string().optional(),
      message: z.string().optional(),
    }),
  },
];
