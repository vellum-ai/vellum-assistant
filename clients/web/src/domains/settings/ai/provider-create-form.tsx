import { useMemo, useState, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";
import { ChevronRight } from "lucide-react";

import { credentialPresenceQueryKey, useStoredCredentialPresence } from "@/domains/settings/ai/use-stored-credential-presence";
import { secretsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
    inferenceProviderconnectionsPost,
    secretsPost,
} from "@/generated/daemon/sdk.gen";

import { providerSupportsPlatformAuth, PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { ChatgptOAuthSection } from "@/domains/settings/ai/chatgpt-oauth-section";
import { deriveProviderDefaults } from "@/domains/settings/ai/profile-prefill";
import type { Auth, ConnectionProvider, InferenceProviderconnectionsPostData, ProviderConnection } from "@/generated/daemon/types.gen";
import { ProviderEditorApiKeySection } from "@/domains/settings/ai/provider-editor-api-key-section";
import {
    AUTH_TYPE_DISPLAY_NAMES,
    connectionSaveErrorMessage,
    parseCredentialRef,
    type AuthType,
} from "@/domains/settings/ai/provider-editor-constants";
import { useSelectableConnectionProviders } from "@/domains/settings/ai/provider-availability";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { useLabelKeySync } from "@/domains/settings/ai/use-label-key-sync";
import { useProviderCredentialsList } from "@/domains/settings/ai/use-provider-credentials-list";

// ---------------------------------------------------------------------------
// ProviderCreateForm
// ---------------------------------------------------------------------------
//
// Controlled presentational form for the CREATE path of a provider
// connection. Lifted out of `ProviderEditorContent` so both the standalone
// "Add Provider" modal (`variant="modal"`) and inline embeddings such as the
// provider-first profile quick-add flow (`variant="inline"`) share the exact
// same create UX, validation strings, and submit sequence
// (`secretsPost` → `inferenceProviderconnectionsPost`).
//
// Edit lives in `ProviderEditorContent` and is intentionally NOT handled
// here — this component is create-only.

export interface ProviderCreateFormProps {
  assistantId: string;
  existingNames: string[];
  /** Pre-selected provider type. */
  defaultProviderType?: ConnectionProvider;
  onCreated: (connection: ProviderConnection) => void;
  onCancel: () => void;
  /** "modal" wraps the form in Modal chrome; "inline" drops it for embedding. */
  variant?: "modal" | "inline";
}

export function ProviderCreateForm({
  assistantId,
  existingNames,
  defaultProviderType,
  onCreated,
  onCancel,
  variant = "modal",
}: ProviderCreateFormProps) {
  const selectableConnectionProviders = useSelectableConnectionProviders();
  const initialProvider: ConnectionProvider =
    defaultProviderType &&
    selectableConnectionProviders.includes(defaultProviderType)
      ? defaultProviderType
      : (selectableConnectionProviders[0] ?? "anthropic");

  // Seed Display Name (label) + Key (name) from the initial provider type so
  // the form opens pre-filled (e.g. Anthropic → "Anthropic" / "anthropic"),
  // deduped against existing connection names. The user can override both, and
  // a provider-type change re-seeds only while they haven't edited the fields
  // (see the dirty guard in the Provider dropdown's onChange below).
  const initialDefaults = deriveProviderDefaults(initialProvider, existingNames);

  const [label, setLabel] = useState(initialDefaults.name);
  const [name, setName] = useState(initialDefaults.key);
  const [provider, setProvider] = useState<ConnectionProvider>(initialProvider);
  const [authType, setAuthType] = useState<AuthType>(() =>
    initialProvider === "ollama"
      ? "none"
      : providerSupportsPlatformAuth(initialProvider)
        ? "platform"
        : "api_key",
  );
  const [credential, setCredential] = useState(() =>
    initialProvider === "ollama" ? "" : `credential/${initialProvider}/api_key`,
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [connectionModels, setConnectionModels] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);

  const isOpenAICompatible = provider === "openai-compatible";
  const connectionProviderOptions = useMemo(() => {
    if (provider && !selectableConnectionProviders.includes(provider)) {
      return [...selectableConnectionProviders, provider];
    }
    return selectableConnectionProviders;
  }, [provider, selectableConnectionProviders]);

  const { handleLabelChange, handleKeyChange: handleNameChange, getDirty } =
    useLabelKeySync("create", setLabel, setName);

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
  const {
    credentials: availableCredentials,
  } = useProviderCredentialsList({
    assistantId,
    enabled: true,
  });

  const nameError = (() => {
    if (!name.trim()) {
      return null;
    }
    if (existingNames.includes(name.trim())) {
      return `A connection named "${name.trim()}" already exists.`;
    }
    return null;
  })();

  const canSave = name.trim().length > 0 && !nameError;

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
              queryKey: secretsGetQueryKey({ path: { assistant_id: assistantId } }),
            });
          } catch {
            setError("Failed to save API key. Please try again.");
            return;
          } finally {
            setIsSavingKey(false);
          }
        } else if (!hasStoredCredential) {
          setError("Enter an API key or select an existing credential.");
          return;
        }

        auth = { type: "api_key", credential: effectiveCredential };
      } else if (authType === "oauth_subscription") {
        // OAuth subscription connections are created by the OAuth flow
        // (ChatgptOAuthSection), not through Save.
        setError("Use the \"Sign in with ChatGPT\" button to connect your subscription.");
        return;
      } else if (authType === "none") {
        auth = { type: "none" };
      } else if (authType === "service_account") {
        setError("Service account connections cannot be created through this form.");
        return;
      } else {
        auth = { type: "platform" };
      }

      const labelValue = label.trim() || null;

      const input: InferenceProviderconnectionsPostData["body"] = {
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
        let serverMessage: string | undefined;
        try {
          const body = await createRes?.json();
          if (typeof body?.error?.message === "string") {
            serverMessage = body.error.message;
          }
        } catch {
          // Response body not JSON-parseable; fall through to generic message.
        }
        setError(serverMessage || connectionSaveErrorMessage(createRes?.status, name.trim()));
        return;
      }
      if (!created) {
        setError("Server returned an empty response. Please try again.");
        return;
      }
      // Single success confirmation for both the standalone and inline
      // surfaces; failures above already surface inline via `error` (no toast).
      toast.success("Provider connected");
      onCreated(created);
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

  // Show the Advanced credential-reference disclosure only when there's at
  // least one stored credential for the provider. In the create-mode empty
  // state the API Key field above is the only path needed — saving a key
  // auto-creates `credential/<provider>/api_key` under the hood, so the
  // disclosure has nothing meaningful to offer.
  const shouldShowAdvancedSection = providerCredentials.length > 0;
  const apiKeyPlaceholder = secretPlaceholder(
    "Enter your API key",
    hasStoredCredential,
  );

  // Display Name + Key are auto-derived from the selected provider and rarely
  // need editing, so they live under an "Advanced" disclosure. Force it open
  // when the Key collides with an existing connection so the error is visible.
  const detailsOpen = isDetailsExpanded || Boolean(nameError);

  const advancedDetailsSection = (
    <div>
      <button
        type="button"
        aria-expanded={detailsOpen}
        onClick={() => setIsDetailsExpanded((v) => !v)}
        className="flex items-center gap-1 text-body-small-default text-[var(--content-secondary)] w-full text-left"
      >
        <ChevronRight
          className={`h-4 w-4 transition-transform ${detailsOpen ? "rotate-90" : ""}`}
        />
        <span>Advanced</span>
      </button>

      {detailsOpen && (
        <div className="mt-2 space-y-4">
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

          {/* Key — editable on create, auto-derived from label */}
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
        </div>
      )}
    </div>
  );

  const body = (
    <div className="space-y-4">
      {/* Provider */}
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          Provider
        </label>
        <Dropdown
          aria-label="Provider"
          value={provider}
          onChange={(newProvider) => {
            setProvider(newProvider);
            // Re-seed Name + Key from the newly selected provider type, but
            // only while the user hasn't manually edited either field (dirty
            // tracking lives in useLabelKeySync). Seeding writes state
            // directly so it doesn't itself flip the dirty flag.
            if (!getDirty()) {
              const { name: seedName, key: seedKey } = deriveProviderDefaults(
                newProvider,
                existingNames,
              );
              setLabel(seedName);
              setName(seedKey);
            }
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
          }}
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
            // Add oauth_subscription when ChatGPT flag is enabled for OpenAI.
            if (provider === "openai") {
              types.push("oauth_subscription");
            }
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
          onConnected={onCreated}
        />
      )}

      {advancedDetailsSection}

      {error && (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-(--system-negative-strong)"
        >
          {error}
        </Typography>
      )}
    </div>
  );

  const footer: ReactNode = (
    <>
      <Button variant="ghost" size="compact" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        variant="primary"
        size="compact"
        disabled={!canSave || saving || isSavingKey}
        onClick={() => void handleSave()}
      >
        {saving ? "Saving…" : "Create"}
      </Button>
    </>
  );

  if (variant === "inline") {
    return (
      <div className="space-y-4">
        {body}
        <div className="flex justify-end gap-2">{footer}</div>
      </div>
    );
  }

  return (
    <Modal.Content size="md">
      <Modal.Header>
        <Modal.Title>New Provider Connection</Modal.Title>
        <Modal.Description>
          Define a provider and auth configuration for inference routing.
        </Modal.Description>
      </Modal.Header>

      <Modal.Body>{body}</Modal.Body>

      <Modal.Footer>{footer}</Modal.Footer>
    </Modal.Content>
  );
}
