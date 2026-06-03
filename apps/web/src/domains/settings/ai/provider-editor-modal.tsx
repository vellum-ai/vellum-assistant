import { useEffect, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { Modal } from "@vellum/design-library/components/modal";
import { Typography } from "@vellum/design-library/components/typography";
import { ChevronRight, Loader2 } from "lucide-react";

import {
  inferenceProviderconnectionsByNamePatch,
  inferenceProviderconnectionsPost,
  secretsGet,
  secretsPost,
  secretsReadPost,
} from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { captureError } from "@/lib/sentry/capture-error";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

import { ChatgptOAuthSection } from "@/domains/settings/ai/chatgpt-oauth-section";
import {
  type Auth,
  type ConnectionProvider,
  type CreateConnectionInput,
  PROVIDER_DISPLAY_NAMES,
  type ProviderConnection,
  type UpdateConnectionInput,
  parseCredentialEntries,
} from "@/domains/settings/ai/provider-connections-client";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { useLabelKeySync } from "@/domains/settings/ai/use-label-key-sync";
import { providerSupportsPlatformAuth } from "@/assistant/llm-model-catalog";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

const PROVIDER_CREDENTIAL_PRESENCE_QK = "provider-credential-presence" as const;
const PROVIDER_CREDENTIALS_LIST_QK = "provider-credentials-list" as const;

function parseCredentialRef(credRef: string): { service: string; field: string } | null {
  const parts = credRef.split("/");
  if (parts.length < 3 || parts[0] !== "credential") return null;
  return { service: parts[1], field: parts.slice(2).join("/") };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function connectionSaveErrorMessage(
  status: number | undefined,
  connectionName: string,
): string {
  switch (status) {
    case 409:
      return `A connection named "${connectionName}" already exists.`;
    case 404:
      return "Connection not found. It may have been deleted.";
    case 400:
      return "Invalid configuration. Check the provider and auth settings.";
    default:
      return "Failed to save connection. Please try again.";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECTION_PROVIDERS: ConnectionProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
  "minimax",
  "openai-compatible",
];

type AuthType = "api_key" | "platform" | "none" | "oauth_subscription";

const AUTH_TYPE_DISPLAY_NAMES: Record<AuthType, string> = {
  api_key: "API Key",
  platform: "Platform (managed proxy)",
  none: "None (local / no auth)",
  oauth_subscription: "ChatGPT Subscription",
};

// NOTE: The set of providers that support `platform` auth is sourced from
// the catalog via `providerSupportsPlatformAuth()` — it's derived from the
// daemon's `PLATFORM_PROVIDER_META` table at catalog build time so the UI
// gate and the proxy routing table cannot drift. See
// `web/scripts/sync-llm-model-catalog.ts` + `web/src/lib/llm-model-catalog.ts`.

// ---------------------------------------------------------------------------
// ProviderEditorContent
// ---------------------------------------------------------------------------
//
// Renders the editor's `Modal.Content` (header + body + footer). The single
// consumer (`ManageProvidersModal`) embeds it directly inside its own
// `Modal.Root` for the master/detail flow — list view and editor view swap
// inside a single modal frame rather than stacking a second modal.

export interface ProviderEditorContentProps {
  /// "managed-edit" is used for connections seeded + write-protected by the
  /// daemon (anthropic-managed / openai-managed / gemini-managed). Only the
  /// auth-related fields (Auth Type, API Key, Credential Reference) are
  /// disabled in this mode; Display Name + Status remain editable to match
  /// the PATCH fields the daemon allows on managed rows.
  mode: "create" | "edit" | "managed-edit";
  connection?: ProviderConnection;
  assistantId: string;
  existingNames: string[];
  openAICompatibleEndpointsEnabled?: boolean;
  chatgptSubscriptionEnabled?: boolean;
  onSave: (connection: ProviderConnection) => void;
  onCancel: () => void;
}

export function ProviderEditorContent({
  mode,
  connection,
  assistantId,
  existingNames,
  openAICompatibleEndpointsEnabled = false,
  chatgptSubscriptionEnabled = false,
  onSave,
  onCancel,
}: ProviderEditorContentProps) {
  /// Local mode state. Initialised from the `mode` prop, but the user can
  /// flip "managed-edit" → "create" via the Save as New button — they clone
  /// a managed connection's provider + label into a new (non-managed)
  /// connection of their own. Mirrors `effectiveMode` in
  /// `profile-editor-modal.tsx` where the same Save As New pattern lives.
  const [effectiveMode, setEffectiveMode] = useState<
    "create" | "edit" | "managed-edit"
  >(mode);

  /// True when the editor is opened for a Vellum-managed connection. Locks
  /// the auth-related inputs (Auth Type, API Key, Credential Reference) but
  /// leaves Display Name + Status editable, mirroring what the daemon
  /// permits on PATCH for managed rows. Keyed off `effectiveMode` so the
  /// Save As New transition out of managed-edit also unlocks auth.
  const isAuthLocked = effectiveMode === "managed-edit";

  const [label, setLabel] = useState(connection?.label ?? "");
  const [name, setName] = useState(connection?.name ?? "");
  const [provider, setProvider] = useState<ConnectionProvider>(
    connection?.provider ?? "anthropic",
  );
  const [authType, setAuthType] = useState<AuthType>(() => {
    if (!connection) return "platform";
    return connection.auth.type as AuthType;
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
  const connectionProviderOptions = useMemo(() => {
    const options = openAICompatibleEndpointsEnabled
      ? CONNECTION_PROVIDERS
      : CONNECTION_PROVIDERS.filter((p) => p !== "openai-compatible");
    if (provider && !options.includes(provider)) {
      return [...options, provider];
    }
    return options;
  }, [openAICompatibleEndpointsEnabled, provider]);

  const { handleLabelChange, handleKeyChange: handleNameChange, resetDirty } =
    useLabelKeySync(effectiveMode, setLabel, setName);

  // New state for inline API key editing
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [isAdvancedExpanded, setIsAdvancedExpanded] = useState(false);
  const [isCreatingNewCredential, setIsCreatingNewCredential] = useState(false);
  const [newCredentialName, setNewCredentialName] = useState("");
  const [isSavingKey, setIsSavingKey] = useState(false);
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();

  // --- Credential presence query (TanStack Query) ---
  const parsedCredRef = useMemo(() => parseCredentialRef(credential), [credential]);
  const needsCredentialCheck = authType === "api_key" && parsedCredRef !== null;

  const credentialPresenceKey = useMemo(
    () => [PROVIDER_CREDENTIAL_PRESENCE_QK, assistantId, parsedCredRef?.service ?? "", parsedCredRef?.field ?? ""],
    [assistantId, parsedCredRef],
  );

  const credentialPresenceQuery = useQuery({
    queryKey: credentialPresenceKey,
    queryFn: async () => {
      const { data, error, response } = await secretsReadPost({
        path: { assistant_id: assistantId },
        body: { type: "credential", name: `${parsedCredRef!.service}:${parsedCredRef!.field}` },
        throwOnError: false,
      });
      assertHasResponse(response, error, "Failed to check stored credential");
      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(error, response, `Failed to check stored credential (HTTP ${response.status})`),
        );
      }
      return data!.found;
    },
    enabled: !!assistantId && needsCredentialCheck && isOrgReady,
    retry: shouldRetryDaemonError,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!credentialPresenceQuery.error) return;
    captureError(credentialPresenceQuery.error, {
      context: "settings-provider-editor-credential-presence",
      bestEffort: true,
    });
  }, [credentialPresenceQuery.error]);

  const hasStoredCredential = credentialPresenceQuery.data ?? false;
  const isLoadingCredential = credentialPresenceQuery.isLoading && needsCredentialCheck;

  // --- Available credentials list query (TanStack Query) ---
  const needsCredentialsList =
    authType === "api_key" || effectiveMode === "create";

  const credentialsListKey = useMemo(
    () => [PROVIDER_CREDENTIALS_LIST_QK, assistantId],
    [assistantId],
  );

  const credentialsListQuery = useQuery({
    queryKey: credentialsListKey,
    queryFn: async () => {
      const { data, error, response } = await secretsGet({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });
      assertHasResponse(response, error, "Failed to load credentials");
      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(error, response, `Failed to load credentials (HTTP ${response.status})`),
        );
      }
      return parseCredentialEntries(data!.secrets ?? data!.accounts ?? []);
    },
    enabled: !!assistantId && needsCredentialsList && isOrgReady,
    retry: shouldRetryDaemonError,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!credentialsListQuery.error) return;
    captureError(credentialsListQuery.error, {
      context: "settings-provider-editor-credentials-list",
      bestEffort: true,
    });
  }, [credentialsListQuery.error]);

  const availableCredentials = credentialsListQuery.data ?? [];

  // Reset form when connection prop changes (e.g. switching between edit
  // targets). `effectiveMode` doesn't need a sync line here — it's
  // initialised from the `mode` prop via `useState(mode)`, and the editor
  // unmounts/remounts whenever the parent flips list ↔ editor view (see
  // `ManageProvidersModal`'s `editorOpen ? <ProviderEditorContent /> : null`).
  // So the useState initializer re-runs on every fresh open with the latest
  // `mode` prop, and any Save as New transition is automatically discarded
  // when the user returns to the list and re-opens.
  useEffect(() => {
    const effectiveProvider = connection?.provider ?? "anthropic";
    setLabel(connection?.label ?? "");
    setName(connection?.name ?? "");
    setProvider(effectiveProvider);
    setAuthType(connection ? (connection.auth.type as AuthType) : "platform");
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
    setApiKeyValue("");
    setIsCreatingNewCredential(false);
    setNewCredentialName("");
    setIsSavingKey(false);
    setIsAdvancedExpanded(false);
  }, [connection, resetDirty]);

  /// Save as New: clone the currently-displayed connection into a fresh
  /// "create" mode session. The user keeps the provider + label as a
  /// starting point (so they don't have to re-enter the easy bits) but
  /// gets a blank Key field to pick a unique name, fresh credential
  /// inputs, and an unlocked Auth Type (default to api_key, the most
  /// common path for cloning off a managed connection — the whole point
  /// is the user wants to use their own credentials).
  ///
  /// Mirrors `setEffectiveMode("create")` in profile-editor-modal's Save
  /// As New footer button.
  function handleSaveAsNew() {
    setEffectiveMode("create");
    // Clear the Key so the user picks a new unique name. Reset the dirty
    // flag so subsequent Label edits auto-derive the Key, matching the
    // create-mode default UX.
    setName("");
    resetDirty();
    if (provider === "ollama") {
      setAuthType("none");
      setCredential("");
    } else {
      setAuthType("api_key");
      setCredential(`credential/${provider}/api_key`);
    }
    setApiKeyValue("");
    setBaseUrl("");
    setConnectionModels("");
    setError(null);
    // TQ credential queries auto-refetch: credential ref change above
    // triggers a new presence query key, and the credentials list query
    // stays enabled (effectiveMode is now "create").
  }

  const nameError = (() => {
    if (!name.trim()) return null;
    if (effectiveMode === "create" && existingNames.includes(name.trim())) {
      return `A connection named "${name.trim()}" already exists.`;
    }
    return null;
  })();

  const canSave = name.trim().length > 0 && !nameError;

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
            const parts = effectiveCredential.split("/");
            if (parts.length >= 3 && parts[0] === "credential") {
              const service = parts[1];
              const field = parts.slice(2).join("/");
              await secretsPost({
                path: { assistant_id: assistantId },
                body: {
                  type: "credential",
                  name: `${service}:${field}`,
                  value: trimmedKey,
                },
                throwOnError: true,
              });
            } else {
              await secretsPost({
                path: { assistant_id: assistantId },
                body: {
                  type: "api_key",
                  name: provider,
                  value: trimmedKey,
                },
                throwOnError: true,
              });
            }
            // Optimistically mark credential as present and invalidate
            // the credentials list so TQ caches stay in sync.
            queryClient.setQueryData(credentialPresenceKey, true);
            void queryClient.invalidateQueries({ queryKey: credentialsListKey });
          } catch {
            setError("Failed to save API key. Please try again.");
            return;
          } finally {
            setIsSavingKey(false);
          }
        } else if (
          !hasStoredCredential &&
          effectiveMode === "create"
        ) {
          setError("Enter an API key or select an existing credential.");
          return;
        }

        auth = { type: "api_key", credential: effectiveCredential };
      } else if (authType === "oauth_subscription") {
        if (effectiveMode !== "create" && connection?.auth.type === "oauth_subscription") {
          // Editing an existing oauth_subscription connection — preserve
          // the stored auth so users can update display name / status.
          auth = connection.auth;
        } else {
          // Create mode: OAuth subscription connections are created by
          // the OAuth flow (handleChatgptUrlSubmit), not through Save.
          setError("Use the \"Sign in with ChatGPT\" button to connect your subscription.");
          return;
        }
      } else if (authType === "none") {
        auth = { type: "none" };
      } else {
        auth = { type: "platform" };
      }

      const labelValue = label.trim() || null;

      let saved: ProviderConnection;
      if (effectiveMode === "create") {
        // Create path — used by genuine create-mode opens AND by the
        // Save as New transition out of managed-edit. POSTs to
        // `createConnection` either way, so the daemon assigns a fresh
        // row that the user owns (not a managed clone).
        const input: CreateConnectionInput = {
          name: name.trim(),
          provider,
          auth,
          ...(labelValue !== null && { label: labelValue }),
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
        const { data: created, response: createRes } = await inferenceProviderconnectionsPost({
          path: { assistant_id: assistantId },
          body: input,
        });
        if (!createRes?.ok) {
          setError(connectionSaveErrorMessage(createRes?.status, name.trim()));
          return;
        }
        if (!created) {
          setError("Server returned an empty response. Please try again.");
          return;
        }
        saved = created;
      } else {
        const input: UpdateConnectionInput = {
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
          setError(connectionSaveErrorMessage(updateRes?.status, name.trim()));
          return;
        }
        if (!updated) {
          setError("Server returned an empty response. Please try again.");
          return;
        }
        saved = updated;
      }
      onSave(saved);
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
  // at least one stored credential for the provider OR the user is
  // mid-create of a named credential OR we're editing an existing
  // `api_key` connection (so the user can always see their current
  // reference, even if `availableCredentials` came back empty due to
  // an out-of-band deletion or daemon hiccup). In the create-mode
  // empty state the API Key field above
  // is the only path needed — saving a key auto-creates
  // `credential/<provider>/api_key` under the hood, so the disclosure
  // has nothing meaningful to offer. Mirrors macOS
  // `ProvidersSheet.swift`'s `shouldShowAdvancedSection`.
  const isEditingApiKeyConnection =
    effectiveMode !== "create" && connection?.auth.type === "api_key";
  const shouldShowAdvancedSection =
    providerCredentials.length > 0 ||
    isCreatingNewCredential ||
    isEditingApiKeyConnection;
  const apiKeyPlaceholder = secretPlaceholder(
    "Enter your API key",
    hasStoredCredential,
  );

  return (
    <Modal.Content size="md">
      <Modal.Header>
        <Modal.Title>
          {effectiveMode === "create"
            ? "New Provider Connection"
            : "Edit Connection"}
        </Modal.Title>
        <Modal.Description>
          {effectiveMode === "create"
            ? "Define a provider and auth configuration for inference routing."
            : isAuthLocked
              ? `Managed by Vellum — auth is locked, but you can rename "${connection?.name}".`
              : `Editing "${connection?.name}".`}
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

        {/* Key — only editable on create, auto-derived from label */}
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Key
          </label>
          <Input
            value={name}
            onChange={(e) => {
              handleNameChange(e.target.value);
              setError(null);
            }}
            placeholder="e.g. anthropic-personal"
            disabled={effectiveMode !== "create"}
            fullWidth
          />
          {nameError && (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-(--system-negative-strong)"
            >
              {nameError}
            </Typography>
          )}
        </div>

        {/* Provider — only selectable on create */}
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Provider
          </label>
          <Dropdown
            aria-label="Provider"
            value={provider}
            onChange={(v) => {
              const newProvider = v as ConnectionProvider;
              setProvider(newProvider);
              if (effectiveMode === "create") {
                if (newProvider === "ollama") {
                  setAuthType("none");
                  setCredential("");
                } else {
                  setAuthType((prev) => {
                    if (prev === "none") {
                      return "api_key";
                    }
                    if (
                      prev === "oauth_subscription" &&
                      newProvider !== "openai"
                    ) {
                      return "api_key";
                    }
                    if (
                      prev === "platform" &&
                      !providerSupportsPlatformAuth(newProvider)
                    ) {
                      return "api_key";
                    }
                    return prev;
                  });
                  setCredential(`credential/${newProvider}/api_key`);
                }
                // Credential ref changes above trigger a new TQ query key,
                // so the presence check auto-refetches for the new provider.
              }
            }}
            disabled={effectiveMode !== "create"}
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
                disabled={isAuthLocked}
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
                disabled={isAuthLocked}
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
              setAuthType(v as AuthType);
              setError(null);
            }}
            disabled={isAuthLocked || provider === "ollama"}
            options={(() => {
              let types: AuthType[];
              if (provider === "ollama") {
                types = ["none"];
              } else if (providerSupportsPlatformAuth(provider)) {
                types = ["api_key", "platform"];
              } else {
                types = ["api_key"];
              }
              // Add oauth_subscription when ChatGPT flag is enabled for
              // OpenAI in create mode.
              if (
                chatgptSubscriptionEnabled &&
                provider === "openai" &&
                effectiveMode === "create"
              ) {
                types.push("oauth_subscription");
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
          <>
            {/* Primary: saved-state API Key field */}
            <div className="space-y-1">
              <label className="block text-body-small-default text-[var(--content-tertiary)]">
                API Key
              </label>
              {isLoadingCredential ? (
                <div className="flex items-center gap-2 h-8">
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
                  <Typography
                    variant="body-small-default"
                    className="text-[var(--content-tertiary)]"
                  >
                    Loading…
                  </Typography>
                </div>
              ) : (
                <Input
                  type="password"
                  value={apiKeyValue}
                  onChange={(e) => {
                    setApiKeyValue(e.target.value);
                    setError(null);
                  }}
                  placeholder={apiKeyPlaceholder}
                  disabled={isAuthLocked}
                  fullWidth
                />
              )}
            </div>

            {/* Advanced credential-reference disclosure. Hidden when
                the provider has zero stored credentials so the simple
                API Key field above is the only path — saving a key
                auto-creates `credential/<provider>/api_key` under the
                hood, matching the macOS pattern. Once at least one
                credential exists (or the user is mid-create of a named
                credential) the disclosure re-appears with the reference
                dropdown + New Credential affordance. */}
            {shouldShowAdvancedSection && (
              <div>
                <button
                  type="button"
                  aria-expanded={isAdvancedExpanded}
                  onClick={() => setIsAdvancedExpanded((v) => !v)}
                  className="flex items-center gap-1 text-body-small-default text-[var(--content-secondary)] w-full text-left"
                >
                  <ChevronRight
                    className={`h-4 w-4 transition-transform ${isAdvancedExpanded ? "rotate-90" : ""}`}
                  />
                  <span>Advanced</span>
                  <span className="text-[var(--content-tertiary)] ml-1">
                    · Credential reference
                  </span>
                </button>

              {isAdvancedExpanded && (
                <div className="mt-2 space-y-3">
                  {/* Build dropdown options from available credentials. If
                      the connection's current `credential` reference isn't
                      in the list (e.g. credential deleted out-of-band, or
                      daemon returned an empty list while editing), prepend
                      a synthetic option for it so the user still sees
                      their actual reference rather than a blank dropdown. */}
                  {(() => {
                    const baseOptions = providerCredentials.map((c) => {
                      const ref = `credential/${c.service}/${c.field}`;
                      return { label: ref, value: ref };
                    });
                    const hasCurrent = baseOptions.some(
                      (o) => o.value === credential,
                    );
                    const dropdownOptions =
                      credential && !hasCurrent
                        ? [{ label: credential, value: credential }, ...baseOptions]
                        : baseOptions;
                    if (dropdownOptions.length === 0) return null;
                    return (
                      <div className="space-y-1">
                        <label className="block text-body-small-default text-[var(--content-tertiary)]">
                          Credential Reference
                        </label>
                        <Dropdown
                          aria-label="Credential reference"
                          value={credential}
                          onChange={(v) => {
                            setCredential(v);
                          }}
                          disabled={isAuthLocked}
                          options={dropdownOptions}
                        />
                      </div>
                    );
                  })()}

                  {isCreatingNewCredential && (
                    <div className="space-y-1">
                      <label className="block text-body-small-default text-[var(--content-tertiary)]">
                        New Credential Name
                      </label>
                      <div className="flex gap-2">
                        <Input
                          value={newCredentialName}
                          onChange={(e) => setNewCredentialName(e.target.value)}
                          placeholder="e.g. team-key"
                          disabled={isAuthLocked}
                          fullWidth
                        />
                        <Button
                          variant="primary"
                          size="compact"
                          disabled={isAuthLocked || !newCredentialName.trim()}
                          onClick={() => {
                            const trimmed = newCredentialName.trim();
                            if (!trimmed) return;
                            const ref = `credential/${provider}/${trimmed}`;
                            setCredential(ref);
                            setIsCreatingNewCredential(false);
                            setNewCredentialName("");
                          }}
                        >
                          Use
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="compact"
                      disabled={isAuthLocked}
                      onClick={() => {
                        if (isCreatingNewCredential) {
                          setIsCreatingNewCredential(false);
                          setNewCredentialName("");
                        } else {
                          setIsCreatingNewCredential(true);
                        }
                      }}
                    >
                      {isCreatingNewCredential
                        ? "Cancel"
                        : "+ New Credential"}
                    </Button>
                  </div>
                </div>
              )}
              </div>
            )}
          </>
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
        {/* Save as New: only offered for managed connections. The user
            clones the row's provider + label into a fresh "create" mode
            session where they can supply their own credential. Hidden
            for plain edit because rename/clone of an unmanaged row is a
            different workflow (delete + create). */}
        {effectiveMode === "managed-edit" && (
          <Button
            variant="outlined"
            size="compact"
            onClick={handleSaveAsNew}
            disabled={saving || isSavingKey}
          >
            Save as New
          </Button>
        )}
        <Button
          variant="primary"
          size="compact"
          disabled={!canSave || saving || isSavingKey}
          onClick={() => void handleSave()}
        >
          {saving
            ? "Saving…"
            : effectiveMode === "create"
              ? "Create"
              : "Save"}
        </Button>
      </Modal.Footer>
    </Modal.Content>
  );
}
