import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { Toggle } from "@vellum/design-library/components/toggle";
import { Modal } from "@vellum/design-library/components/modal";
import { Typography } from "@vellum/design-library/components/typography";
import { ChevronRight, Loader2 } from "lucide-react";

import {
  type Auth,
  type ConnectionProvider,
  type ConnectionStatus,
  type CreateConnectionInput,
  type CredentialEntry,
  PROVIDER_DISPLAY_NAMES,
  type ProviderConnection,
  type UpdateConnectionInput,
  createConnection,
  exchangeChatgptAuthCode,
  listConnections,
  listCredentials,
  readSecret,
  startChatgptSubscriptionAuth,
  updateConnection,
  writeSecret,
} from "@/domains/settings/ai/provider-connections-client";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { toKebabCase } from "@/domains/settings/ai/slugify";
import { providerSupportsPlatformAuth } from "@/assistant/llm-model-catalog";

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
  const [status, setStatus] = useState<ConnectionStatus>(
    connection?.status ?? "active",
  );
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

  // keyDirty tracks whether the user has manually edited the key field
  const keyDirty = useRef(false);

  // New state for inline API key editing
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [isAdvancedExpanded, setIsAdvancedExpanded] = useState(false);
  const [hasStoredCredential, setHasStoredCredential] = useState(false);
  const [isLoadingCredential, setIsLoadingCredential] = useState(false);
  const [availableCredentials, setAvailableCredentials] = useState<
    CredentialEntry[]
  >([]);
  const [isCreatingNewCredential, setIsCreatingNewCredential] = useState(false);
  const [newCredentialName, setNewCredentialName] = useState("");
  const [isSavingKey, setIsSavingKey] = useState(false);

  // -- ChatGPT Subscription OAuth state -------------------------------------
  type ChatgptOAuthState =
    | "idle"
    | "starting"
    | "paste_url"
    | "exchanging"
    | "completed"
    | "failed";
  const [chatgptOAuthState, setChatgptOAuthState] =
    useState<ChatgptOAuthState>("idle");
  const [chatgptPastedUrl, setChatgptPastedUrl] = useState("");
  const [chatgptOAuthError, setChatgptOAuthError] = useState<string | null>(
    null,
  );
  const chatgptStateRef = useRef<string>("");

  async function handleChatgptSignIn() {
    setChatgptOAuthState("starting");
    setChatgptOAuthError(null);
    const popup = window.open("about:blank", "_blank");
    try {
      const { authorize_url, state } =
        await startChatgptSubscriptionAuth(assistantId);
      chatgptStateRef.current = state;
      if (popup) {
        popup.opener = null;
        popup.location.href = authorize_url;
      } else {
        window.open(authorize_url, "_blank", "noopener");
      }
      setChatgptOAuthState("paste_url");
    } catch {
      popup?.close();
      setChatgptOAuthState("failed");
      setChatgptOAuthError("Failed to start ChatGPT sign-in. Please try again.");
    }
  }

  async function handleChatgptUrlSubmit() {
    setChatgptOAuthError(null);
    const trimmed = chatgptPastedUrl.trim();
    if (!trimmed) {
      setChatgptOAuthError("Please paste the URL from the error page.");
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      setChatgptOAuthError("Invalid URL. Please paste the full URL from the address bar.");
      return;
    }
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    if (!code) {
      setChatgptOAuthError("The URL is missing the authorization code. Make sure you copied the full URL.");
      return;
    }
    if (!state) {
      setChatgptOAuthError("The URL is missing the state parameter. Make sure you copied the full URL.");
      return;
    }
    setChatgptOAuthState("exchanging");
    try {
      await exchangeChatgptAuthCode(assistantId, code, state);
      setChatgptOAuthState("completed");
      const conns = await listConnections(assistantId, "openai");
      const chatgptConn = conns.find(
        (c) =>
          c.name === "chatgpt-subscription" || c.name === "openai-chatgpt",
      );
      if (chatgptConn) {
        onSave(chatgptConn);
      } else {
        onSave({
          name: "chatgpt-subscription",
          provider: "openai",
          auth: { type: "oauth_subscription", credential: "credential/openai/chatgpt-subscription" },
          status: "active",
          label: "ChatGPT Subscription",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          baseUrl: null,
          models: null,
        });
      }
    } catch {
      setChatgptOAuthState("failed");
      setChatgptOAuthError("Failed to complete sign-in. Please try again.");
    }
  }

  const loadCredentialPresence = useCallback(
    async (credRef: string) => {
      const parts = credRef.split("/");
      if (parts.length < 3 || parts[0] !== "credential") {
        setHasStoredCredential(false);
        return;
      }
      const service = parts[1];
      const field = parts.slice(2).join("/");
      setIsLoadingCredential(true);
      try {
        const result = await readSecret(
          assistantId,
          "credential",
          `${service}:${field}`,
        );
        setHasStoredCredential(result.found);
      } catch {
        setHasStoredCredential(false);
      } finally {
        setIsLoadingCredential(false);
      }
    },
    [assistantId],
  );

  const loadAvailableCredentials = useCallback(async () => {
    const creds = await listCredentials(assistantId);
    setAvailableCredentials(creds);
  }, [assistantId]);

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
    setStatus(connection?.status ?? "active");
    keyDirty.current = false;

    setError(null);

    // Reset openai-compatible fields
    setBaseUrl(connection?.baseUrl ?? "");
    setConnectionModels(
      connection?.models ? connection.models.map((m) => m.id).join(", ") : "",
    );

    // Reset credential UI state
    setApiKeyValue("");
    setHasStoredCredential(false);
    setIsLoadingCredential(false);
    setAvailableCredentials([]);
    setIsCreatingNewCredential(false);
    setNewCredentialName("");
    setIsSavingKey(false);
    setIsAdvancedExpanded(false);

    // Reset ChatGPT OAuth state
    setChatgptOAuthState("idle");
    setChatgptPastedUrl("");
    setChatgptOAuthError(null);
    chatgptStateRef.current = "";

    // Load credential data for edit mode with api_key auth
    if (connection?.auth.type === "api_key") {
      void loadCredentialPresence(connection.auth.credential);
      void loadAvailableCredentials();
    } else if (!connection) {
      // Create mode: pre-load available credentials for the Advanced section
      void loadAvailableCredentials();
    }
  }, [connection, loadCredentialPresence, loadAvailableCredentials]);

  // Auto-derive key from label when not dirty and in create mode
  function handleLabelChange(newLabel: string) {
    setLabel(newLabel);
    if (effectiveMode === "create" && !keyDirty.current) {
      setName(toKebabCase(newLabel));
    }
  }

  function handleNameChange(newName: string) {
    keyDirty.current = true;
    setName(newName);
  }

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
    keyDirty.current = false;
    if (provider === "ollama") {
      setAuthType("none");
      setCredential("");
    } else {
      setAuthType("api_key");
      setCredential(`credential/${provider}/api_key`);
    }
    setApiKeyValue("");
    setHasStoredCredential(false);
    setBaseUrl("");
    setConnectionModels("");
    // New connection starts active by convention; user can toggle off
    // before saving if they want it disabled.
    setStatus("active");
    setError(null);
    // Pre-load the credentials list so the Advanced section's dropdown
    // is populated when the user expands it.
    void loadAvailableCredentials();
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
              await writeSecret(
                assistantId,
                "credential",
                `${service}:${field}`,
                trimmedKey,
              );
            } else {
              await writeSecret(assistantId, "api_key", provider, trimmedKey);
            }
            setHasStoredCredential(true);
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
          ...(status !== "active" && { status }),
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
        saved = await createConnection(assistantId, input);
      } else {
        const input: UpdateConnectionInput = {
          auth,
          label: labelValue,
          status,
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
        saved = await updateConnection(assistantId, connection!.name, input);
      }
      onSave(saved);
    } catch (err) {
      const httpStatus = (err as { status?: number })?.status;
      if (httpStatus === 409) {
        setError(`A connection named "${name.trim()}" already exists.`);
      } else if (httpStatus === 404) {
        setError("Connection not found. It may have been deleted.");
      } else if (httpStatus === 400) {
        setError("Invalid configuration. Check the provider and auth settings.");
      } else {
        setError("Failed to save connection. Please try again.");
      }
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
  // an out-of-band deletion or daemon hiccup — Devin finding on
  // PR #6535). In the create-mode empty state the API Key field above
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
              ? `Managed by Vellum — auth is locked, but you can rename or disable "${connection?.name}".`
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
                setHasStoredCredential(false);
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
                      their actual reference rather than a blank dropdown.
                      Devin finding on PR #6535. */}
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
                            void loadCredentialPresence(v);
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
                            void loadCredentialPresence(ref);
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
          <div className="space-y-3 rounded-lg border border-[var(--border-default)] p-4">
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              Connect your ChatGPT subscription to use OpenAI models without an
              API key.
            </Typography>

            {chatgptOAuthState === "idle" ? (
              <Button
                variant="outlined"
                size="compact"
                onClick={() => void handleChatgptSignIn()}
              >
                Sign in with ChatGPT
              </Button>
            ) : null}

            {chatgptOAuthState === "starting" ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
                <Typography
                  variant="body-small-default"
                  className="text-[var(--content-tertiary)]"
                >
                  Starting sign-in...
                </Typography>
              </div>
            ) : null}

            {chatgptOAuthState === "paste_url" ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Typography
                    variant="body-small-default"
                    as="p"
                    className="text-[var(--content-secondary)]"
                  >
                    1. Sign in with ChatGPT in the popup
                  </Typography>
                  <Typography
                    variant="body-small-default"
                    as="p"
                    className="text-[var(--content-secondary)]"
                  >
                    2. After sign-in, you&apos;ll see an error page
                  </Typography>
                  <Typography
                    variant="body-small-default"
                    as="p"
                    className="text-[var(--content-secondary)]"
                  >
                    3. Copy the URL from the address bar and paste it below
                  </Typography>
                </div>
                <Input
                  value={chatgptPastedUrl}
                  onChange={(e) => {
                    setChatgptPastedUrl(e.target.value);
                    setChatgptOAuthError(null);
                  }}
                  placeholder="Paste callback URL here..."
                  fullWidth
                />
                <div className="flex justify-end">
                  <Button
                    variant="primary"
                    size="compact"
                    disabled={!chatgptPastedUrl.trim()}
                    onClick={() => void handleChatgptUrlSubmit()}
                  >
                    Complete Sign In
                  </Button>
                </div>
              </div>
            ) : null}

            {chatgptOAuthState === "exchanging" ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
                <Typography
                  variant="body-small-default"
                  className="text-[var(--content-tertiary)]"
                >
                  Completing sign-in...
                </Typography>
              </div>
            ) : null}

            {chatgptOAuthState === "completed" ? (
              <Typography
                variant="body-small-default"
                as="p"
                className="text-[var(--system-positive-strong)]"
              >
                ChatGPT subscription connected successfully.
              </Typography>
            ) : null}

            {chatgptOAuthError ? (
              <Typography
                variant="body-small-default"
                as="p"
                className="text-(--system-negative-strong)"
              >
                {chatgptOAuthError}
              </Typography>
            ) : null}

            {chatgptOAuthState === "failed" ? (
              <Button
                variant="outlined"
                size="compact"
                onClick={() => {
                  setChatgptOAuthState("idle");
                  setChatgptPastedUrl("");
                  setChatgptOAuthError(null);
                }}
              >
                Try Again
              </Button>
            ) : null}
          </div>
        )}

        {/* Status — always editable, including for managed connections. */}
        <Toggle
          checked={status === "active"}
          onChange={(v) => setStatus(v ? "active" : "disabled")}
          label="Active"
        />

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
