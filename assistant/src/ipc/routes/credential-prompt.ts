/**
 * IPC route for securely prompting the user for a credential via the UI.
 *
 * CLI commands and skill scripts call this route to trigger a secure input
 * prompt in the user's app. The handler broadcasts the prompt to all
 * connected clients, stores the credential and its metadata on success.
 */

import { z } from "zod";

import { syncManualTokenConnection } from "../../oauth/manual-token-connection.js";
import type { SecretPromptResult } from "../../permissions/secret-prompter.js";
import { credentialKey } from "../../security/credential-key.js";
import { setSecureKeyAsync } from "../../security/secure-keys.js";
import {
  assertMetadataWritable,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import type { IpcRoute } from "../assistant-server.js";

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
  allowedDomains: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  injectionTemplates: z.array(InjectionTemplateSchema).optional(),
});

// ---------------------------------------------------------------------------
// Response type (shared with CLI consumer)
// ---------------------------------------------------------------------------

export type CredentialPromptResult = {
  ok: boolean;
  error?: string;
  service?: string;
  field?: string;
};

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface CredentialPromptDeps {
  /** Request a secret from the user, using the standalone (non-conversation) path. */
  requestSecretStandalone: (params: {
    service: string;
    field: string;
    label: string;
    description?: string;
    placeholder?: string;
    allowedTools?: string[];
    allowedDomains?: string[];
  }) => Promise<SecretPromptResult>;
}

let deps: CredentialPromptDeps | null = null;

export function registerCredentialPromptDeps(d: CredentialPromptDeps): void {
  deps = d;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const credentialPromptRoute: IpcRoute = {
  method: "credentials/prompt",
  handler: async (params) => {
    if (!deps) {
      throw new Error("credentials/prompt: deps not registered");
    }

    const validated = CredentialPromptParams.parse(params);

    assertMetadataWritable();

    const result = await deps.requestSecretStandalone({
      service: validated.service,
      field: validated.field,
      label: validated.label,
      description: validated.description,
      placeholder: validated.placeholder,
      allowedTools: validated.allowedTools,
      allowedDomains: validated.allowedDomains,
    });

    if (!result.value) {
      const reason =
        result.error === "unsupported_channel"
          ? "No connected client supports secure credential entry"
          : "User cancelled the credential prompt";
      return { ok: false, error: reason };
    }

    // Store the secret
    const key = credentialKey(validated.service, validated.field);
    const stored = await setSecureKeyAsync(key, result.value);
    if (!stored) {
      return { ok: false, error: "Failed to store credential" };
    }

    // Write metadata and sync provider connection state
    upsertCredentialMetadata(validated.service, validated.field, {
      allowedTools: validated.allowedTools,
      allowedDomains: validated.allowedDomains,
      injectionTemplates: validated.injectionTemplates,
    });
    await syncManualTokenConnection(validated.service);

    return {
      ok: true,
      service: validated.service,
      field: validated.field,
    };
  },
};
