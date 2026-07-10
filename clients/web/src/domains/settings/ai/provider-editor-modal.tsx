import { useEffect, useMemo, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

import { credentialPresenceQueryKey, useStoredCredentialPresence } from "@/domains/settings/ai/use-stored-credential-presence";
import { secretsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
    inferenceProviderconnectionsByNamePatch,
    secretsPost,
} from "@/generated/daemon/sdk.gen";

import { providerSupportsPlatformAuth, PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { ChatgptOAuthSection } from "@/domains/settings/ai/chatgpt-oauth-section";
import type { Auth, ConnectionProvider, InferenceProviderconnectionsByNamePatchData, ProviderConnection } from "@/generated/daemon/types.gen";
import { ProviderCreateForm } from "@/domains/settings/ai/provider-create-form";
import { ProviderEditorApiKeySection } from "@/domains/settings/ai/provider-editor-api-key-section";
import {
    AUTH_TYPE_DISPLAY_NAMES,
    type AuthType,
    connectionSaveErrorMessage,
    parseCredentialRef,
} from "@/domains/settings/ai/provider-editor-constants";
import { useSelectableConnectionProviders } from "@/domains/settings/ai/provider-availability";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { useLabelKeySync } from "@/domains/settings/ai/use-label-key-sync";
import { useProviderCredentialsList } from "@/domains/settings/ai/use-provider-credentials-list";

// NOTE: The `platform` auth gate is `providerSupportsPlatformAuth()`. The
// daemon derives `supportsPlatformAuth` from `PLATFORM_PROVIDER_META`
// (assistant/src/providers/platform-proxy/constants.ts) into
// meta/llm-provider-catalog.json via `cd assistant && bun run
// sync:llm-catalog`; the web mirrors it in the hand-maintained
// `PROVIDER_SUPPORTS_PLATFORM_AUTH` map in
// clients/web/src/assistant/llm-model-catalog.ts, with parity tests guarding
// drift against the meta catalog.

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
  const [name, setName] = useState(connection?.name ?? "");
  const [provider, setProvider] = useState<ConnectionProvider>(
    connection?.provider ?? "anthropic",
  );
  const [authType, setAuthType] = useState<AuthType>(() => {
    if (!connection) return "platform";
    return connection.auth.type;
  });
  const [credential, setCredential] = useState(() => {
    if (connection?.auth.type === "api_key") return connection.auth.credential;
    if (!connection) return `credential/anthropic/api_key`;
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
  const selectableConnectionProviders = useSelectableConnectionProviders();
  const connectionProviderOptions = useMemo(() => {
    if (provider && !selectableConnectionProviders.includes(provider)) {
      return [...selectableConnectionProviders, provider];
    }
    return selectableConnectionProviders;
  }, [provider, selectableConnectionProviders]);

  const { handleLabelChange, resetDirty } =
    useLabelKeySync(mode, setLabel, setName);

  const [apiKeyValue, setApiKeyValue] = useState("");
  const [isSavingKey, setIsSavingKey] = useState(false);
  const queryClient = useQueryClient();

  // --- Credential presence (shared hook) ---
  const parsedCredRef = useMemo(() => parseCredentialRef(credential), [credential]);
  const needsCredentialCheck = authType === "api_key" && parsedCredRef !== null;

  const {
    hasStoredCredential,
    isLoading: isLoadingCredential,
  } = useStoredCredentialPresence({
    assistantId,
    credentialKind: "credential",
    credentialName: parsedCredRef ? `${parsedCredRef.service}:${parsedCredRef.field}` : "",
    enabled: needsCredentialCheck,
  });

  // --- Available credentials list ---
  // Create mode is fully owned by ProviderCreateForm (early return below), so
  // the only reachable path here is edit — gate purely on auth.
  const needsCredentialsList = authType === "api_key";

  const {
    credentials: availableCredentials,
  } = useProviderCredentialsList({
    assistantId,
    enabled: needsCredentialsList,
  });

  // Reset form when connection prop changes (e.g. switching between edit
  // targets).
  useEffect(() => {
    const effectiveProvider = connection?.provider ?? "anthropic";
    setLabel(connection?.label ?? "");
    setName(connection?.name ?? "");
    setProvider(effectiveProvider);
    setAuthType(connection ? connection.auth.type : "platform");
    if (connection?.auth.type === "api_key") {
      setCredential(connection.auth.credential);
    } else if (!connection) {
      setCredential(`credential/${effectiveProvider}/api_key`);
    } else {
      setCredential("");
    }
    resetDirty();

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
  }, [connection, resetDirty]);

  // Only edit reaches this component's own Save (create is owned by
  // ProviderCreateForm via the early return below), and the Key field is
  // fixed/disabled there, so a non-empty name is the only save gate. Duplicate
  // -name validation lives in ProviderCreateForm.
  const canSave = name.trim().length > 0;

  async function handleSave() {
    if (!canSave) return;
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
              queryKey: secretsGetQueryKey({ path: { assistant_id: assistantId } }),
            });
          } catch {
            setError("Failed to save API key. Please try again.");
            return;
          } finally {
            setIsSavingKey(false);
          }
        }

        auth = { type: "api_key", credential: effectiveCredential };
      } else if (authType === "oauth_subscription") {
        if (connection?.auth.type === "oauth_subscription") {
          // Editing an existing oauth_subscription connection — preserve
          // the stored auth so users can update display name / status.
          auth = connection.auth;
        } else {
          // OAuth subscription connections are created by the OAuth flow
          // (handleChatgptUrlSubmit), not through Save.
          setError("Use the \"Sign in with ChatGPT\" button to connect your subscription.");
          return;
        }
      } else if (authType === "service_account") {
        if (connection?.auth.type === "service_account") {
          auth = connection.auth;
        } else {
          setError("Service account connections cannot be created through this form.");
          return;
        }
      } else if (authType === "none") {
        auth = { type: "none" };
      } else {
        auth = { type: "platform" };
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
      const { data: updated, response: updateRes } = await inferenceProviderconnectionsByNamePatch({
        path: { assistant_id: assistantId, name: connection?.name ?? name.trim() },
        body: input,
      });
      if (!updateRes?.ok) {
        let serverMessage: string | undefined;
        try {
          const body = await updateRes?.json();
          if (typeof body?.error?.message === "string") {
            serverMessage = body.error.message;
          }
        } catch {
          // Response body not JSON-parseable; fall through to generic message.
        }
        setError(serverMessage || connectionSaveErrorMessage(updateRes?.status, name.trim()));
        return;
      }
      if (!updated) {
        setError("Server returned an empty response. Please try again.");
        return;
      }
      onSave(updated);
    } catch {
      setError("Failed to save connection. Please try again.");
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
    providerCredentials.length > 0 ||
    isEditingApiKeyConnection;
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
        <Modal.Title>Edit Connection</Modal.Title>
        <Modal.Description>
          {`Editing "${connection?.name}".`}
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
            onChange={(e) => handleLabelChange(e.target.value)}
            placeholder="e.g. My Anthropic Key"
            fullWidth
          />
        </div>

        {/* Key — fixed once a connection exists; edit only. */}
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Key
          </label>
          <Input
            value={name}
            placeholder="e.g. anthropic-personal"
            disabled
            fullWidth
          />
        </div>

        {/* Provider — read-only in edit (provider is fixed once a connection
            exists; create mode lives in ProviderCreateForm). */}
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Provider
          </label>
          <Dropdown
            aria-label="Provider"
            value={provider}
            onChange={setProvider}
            disabled
            options={connectionProviderOptions.map((p) => ({
              value: p,
              label: PROVIDER_DISPLAY_NAMES[p],
            }))}
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

        {/* Auth type */}
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Auth Type
          </label>
          <Dropdown
            aria-label="Auth type"
            value={authType}
            onChange={(v) => {
              setAuthType(v);
              setError(null);
            }}
            disabled={provider === "ollama"}
            options={(() => {
              let types: AuthType[];
              if (provider === "ollama") {
                types = ["none"];
              } else if (providerSupportsPlatformAuth(provider)) {
                types = ["api_key", "platform"];
              } else {
                types = ["api_key"];
              }
              // Preserve the current auth type in edit mode so existing
              // connections display their saved value even if the type is
              // no longer offered for new connections.
              if (authType && !types.includes(authType)) {
                types.push(authType);
              }
              return types.map((t) => ({
                value: t,
                label: AUTH_TYPE_DISPLAY_NAMES[t],
              }));
            })()}
          />
        </div>

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
          <ChatgptOAuthSection
            assistantId={assistantId}
            onConnected={onSave}
          />
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
