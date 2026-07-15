import { useEffect, useMemo, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  credentialPresenceQueryKey,
  useStoredCredentialPresence,
} from "@/domains/settings/ai/use-stored-credential-presence";
import { secretsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  inferenceProviderconnectionsByNamePatch,
  secretsPost,
} from "@/generated/daemon/sdk.gen";

import { ChatgptOAuthSection } from "@/domains/settings/ai/chatgpt-oauth-section";
import type {
  Auth,
  ConnectionProvider,
  InferenceProviderconnectionsByNamePatchData,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { ProviderCreateForm } from "@/domains/settings/ai/provider-create-form";
import { ProviderEditorApiKeySection } from "@/domains/settings/ai/provider-editor-api-key-section";
import {
  connectionSaveErrorMessage,
  validationErrorMessage,
  parseCredentialRef,
  providerConnectionDisplayName,
} from "@/domains/settings/ai/provider-editor-constants";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { useProviderCredentialsList } from "@/domains/settings/ai/use-provider-credentials-list";

// ---------------------------------------------------------------------------
// ProviderEditorContent
// ---------------------------------------------------------------------------
//
// Renders the editor's `Modal.Content` (header + body + footer). The single
// consumer (`ManageProvidersModal`) embeds it directly inside its own
// `Modal.Root` for the master/detail flow — list view and editor view swap
// inside a single modal frame rather than stacking a second modal.

export interface ProviderEditorContentProps {
  mode: "create" | "edit";
  connection?: ProviderConnection;
  assistantId: string;
  existingNames: string[];
  onSave: (connection: ProviderConnection) => void;
  onCancel: () => void;
}

export function ProviderEditorContent({
  mode,
  connection,
  assistantId,
  existingNames,
  onSave,
  onCancel,
}: ProviderEditorContentProps) {
  const [label, setLabel] = useState(connection?.label ?? "");
  const name = connection?.name ?? "";
  const provider: ConnectionProvider = connection?.provider ?? "anthropic";
  // Auth is fixed to the stored type — the editor rotates keys but never
  // switches auth modality (that's a different provider entry).
  const authType: Auth["type"] = connection?.auth.type ?? "api_key";
  const [credential, setCredential] = useState(() => {
    if (connection?.auth.type === "api_key") {
      return connection.auth.credential;
    }
    if (!connection) {
      return `credential/anthropic/api_key`;
    }
    return "";
  });
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [connectionModels, setConnectionModels] = useState<string>(() => {
    if (connection?.models) {
      return connection.models.map((m) => m.id).join(", ");
    }
    return "";
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOpenAICompatible = provider === "openai-compatible";

  const [apiKeyValue, setApiKeyValue] = useState("");
  const [isSavingKey, setIsSavingKey] = useState(false);
  const queryClient = useQueryClient();

  // --- Credential presence (shared hook) ---
  const parsedCredRef = useMemo(
    () => parseCredentialRef(credential),
    [credential],
  );
  const needsCredentialCheck = authType === "api_key" && parsedCredRef !== null;

  const { hasStoredCredential, isLoading: isLoadingCredential } =
    useStoredCredentialPresence({
      assistantId,
      credentialKind: "credential",
      credentialName: parsedCredRef
        ? `${parsedCredRef.service}:${parsedCredRef.field}`
        : "",
      enabled: needsCredentialCheck,
    });

  // --- Available credentials list ---
  // Create mode is fully owned by ProviderCreateForm (early return below), so
  // the only reachable path here is edit — gate purely on auth.
  const needsCredentialsList = authType === "api_key";

  const { credentials: availableCredentials } = useProviderCredentialsList({
    assistantId,
    enabled: needsCredentialsList,
  });

  // Reset form when connection prop changes (e.g. switching between edit
  // targets).
  useEffect(() => {
    const effectiveProvider = connection?.provider ?? "anthropic";
    setLabel(connection?.label ?? "");
    if (connection?.auth.type === "api_key") {
      setCredential(connection.auth.credential);
    } else if (!connection) {
      setCredential(`credential/${effectiveProvider}/api_key`);
    } else {
      setCredential("");
    }
    setError(null);

    // Reset openai-compatible fields
    setBaseUrl(connection?.baseUrl ?? "");
    setConnectionModels(
      connection?.models ? connection.models.map((m) => m.id).join(", ") : "",
    );

    // Reset credential UI state. TQ queries auto-refetch when their keys
    // change (credential ref updates above trigger new query keys).
    // Sub-component state (isAdvancedExpanded, isCreatingNewCredential,
    // newCredentialName) resets automatically on unmount/remount.
    setApiKeyValue("");
    setIsSavingKey(false);
  }, [connection]);

  // Only edit reaches this component's own Save. The internal provider name
  // remains fixed, so a non-empty value is the only save gate.
  const canSave = name.trim().length > 0;

  async function handleSave() {
    if (!canSave) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let auth: Auth;

      if (authType === "api_key") {
        const effectiveCredential =
          credential.trim() || `credential/${provider}/api_key`;
        const trimmedKey = apiKeyValue.trim();

        if (trimmedKey) {
          setIsSavingKey(true);
          try {
            const parsed = parseCredentialRef(effectiveCredential);
            await secretsPost({
              path: { assistant_id: assistantId },
              body: parsed
                ? {
                    type: "credential",
                    name: `${parsed.service}:${parsed.field}`,
                    value: trimmedKey,
                  }
                : {
                    type: "api_key",
                    name: provider,
                    value: trimmedKey,
                  },
              throwOnError: true,
            });
            // Optimistically mark credential as present and invalidate
            // the credentials list so TQ caches stay in sync.
            const presenceKey = credentialPresenceQueryKey(
              assistantId,
              "credential",
              parsed ? `${parsed.service}:${parsed.field}` : "",
            );
            queryClient.setQueryData(presenceKey, true);
            void queryClient.invalidateQueries({
              queryKey: secretsGetQueryKey({
                path: { assistant_id: assistantId },
              }),
            });
          } catch {
            setError("Failed to save API key. Please try again.");
            return;
          } finally {
            setIsSavingKey(false);
          }
        }

        auth = { type: "api_key", credential: effectiveCredential };
      } else if (connection) {
        // Non-key auth (oauth_subscription, none, platform, service_account)
        // is preserved verbatim — the editor only changes display fields.
        auth = connection.auth;
      } else {
        setError("Nothing to edit. Close and try again.");
        return;
      }

      const labelValue = label.trim() || null;

      // Edit only — create mode is handled by ProviderCreateForm (see the
      // early return above), which owns the POST path. This component never
      // reaches handleSave in create mode.
      const input: InferenceProviderconnectionsByNamePatchData["body"] = {
        auth,
        label: labelValue,
        ...(isOpenAICompatible && {
          base_url: baseUrl.trim() || null,
          models: connectionModels.trim()
            ? connectionModels
                .split(",")
                .map((id) => ({ id: id.trim() }))
                .filter((m) => m.id)
            : null,
        }),
      };
      const { data: updated, response: updateRes } =
        await inferenceProviderconnectionsByNamePatch({
          path: {
            assistant_id: assistantId,
            name: connection?.name ?? name.trim(),
          },
          body: input,
        });
      if (!updateRes?.ok) {
        setError(
          (await validationErrorMessage(updateRes)) ??
            connectionSaveErrorMessage(updateRes?.status),
        );
        return;
      }
      if (!updated) {
        setError("Server returned an empty response. Please try again.");
        return;
      }
      onSave(updated);
    } catch {
      setError("Failed to save provider. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // Credentials for the current provider (used in the Advanced dropdown)
  const providerCredentials = availableCredentials.filter(
    (c) => c.service === provider,
  );

  // Show the Advanced credential-reference disclosure only when there's
  // at least one stored credential for the provider OR we're editing an
  // existing `api_key` connection (so the user can always see their
  // current reference, even if `availableCredentials` came back empty
  // due to an out-of-band deletion or daemon hiccup). In the
  // create-mode empty state the API Key field above is the only path
  // needed — saving a key auto-creates `credential/<provider>/api_key`
  // under the hood, so the disclosure has nothing meaningful to offer.
  const isEditingApiKeyConnection =
    mode !== "create" && connection?.auth.type === "api_key";
  const shouldShowAdvancedSection =
    providerCredentials.length > 0 || isEditingApiKeyConnection;
  const apiKeyPlaceholder = secretPlaceholder(
    "Enter your API key",
    hasStoredCredential,
  );

  // Create mode is fully owned by the shared ProviderCreateForm. It carries
  // the create-path submit sequence (secretsPost →
  // inferenceProviderconnectionsPost) and renders identical modal chrome.
  // Edit falls through below.
  if (mode === "create") {
    return (
      <ProviderCreateForm
        variant="modal"
        assistantId={assistantId}
        existingNames={existingNames}
        defaultProviderType={provider}
        onCreated={onSave}
        onCancel={onCancel}
      />
    );
  }

  return (
    <Modal.Content size="md">
      <Modal.Header>
        <Modal.Title>Edit Provider</Modal.Title>
        <Modal.Description>
          {connection
            ? `Editing ${providerConnectionDisplayName(connection)}.`
            : "Edit provider settings."}
        </Modal.Description>
      </Modal.Header>

      <Modal.Body className="space-y-4">
        {/* Display Name */}
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Display Name{" "}
            <span className="text-[var(--content-disabled)]">(optional)</span>
          </label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. My Anthropic Key"
            fullWidth
          />
        </div>

        {/* Base URL + Models — openai-compatible only */}
        {isOpenAICompatible && (
          <>
            <div className="space-y-1">
              <label className="block text-body-small-default text-[var(--content-tertiary)]">
                Base URL
              </label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                fullWidth
              />
            </div>
            <div className="space-y-1">
              <label className="block text-body-small-default text-[var(--content-tertiary)]">
                Models
              </label>
              <Input
                value={connectionModels}
                onChange={(e) => setConnectionModels(e.target.value)}
                placeholder="model-1, model-2"
                fullWidth
              />
              <Typography
                variant="body-small-default"
                as="p"
                className="text-[var(--content-tertiary)]"
              >
                Comma-separated model identifiers exposed by your endpoint.
              </Typography>
            </div>
          </>
        )}

        {/* API Key + Advanced disclosure — only shown for api_key auth */}
        {authType === "api_key" && (
          <ProviderEditorApiKeySection
            apiKeyValue={apiKeyValue}
            onApiKeyChange={setApiKeyValue}
            credential={credential}
            onCredentialChange={setCredential}
            isLoadingCredential={isLoadingCredential}
            apiKeyPlaceholder={apiKeyPlaceholder}
            provider={provider}
            providerCredentials={providerCredentials}
            showAdvancedSection={shouldShowAdvancedSection}
            onError={setError}
          />
        )}

        {/* ChatGPT Subscription OAuth — shown when auth type is oauth_subscription */}
        {authType === "oauth_subscription" && (
          <ChatgptOAuthSection assistantId={assistantId} onConnected={onSave} />
        )}

        {error && (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-(--system-negative-strong)"
          >
            {error}
          </Typography>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" size="compact" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="compact"
          disabled={!canSave || saving || isSavingKey}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </Modal.Footer>
    </Modal.Content>
  );
}
