import { useMemo, useRef, useState, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";
import { ChevronRight } from "lucide-react";

import {
  credentialPresenceQueryKey,
  useStoredCredentialPresence,
} from "@/domains/settings/ai/use-stored-credential-presence";
import { secretsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  inferenceProviderconnectionsPost,
  secretsPost,
} from "@/generated/daemon/sdk.gen";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { ChatgptOAuthSection } from "@/domains/settings/ai/chatgpt-oauth-section";
import { deriveProviderDefaults } from "@/domains/settings/ai/profile-prefill";
import type {
  Auth,
  ConnectionProvider,
  InferenceProviderconnectionsPostData,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { ProviderEditorApiKeySection } from "@/domains/settings/ai/provider-editor-api-key-section";
import {
  connectionSaveErrorMessage,
  parseCredentialRef,
} from "@/domains/settings/ai/provider-editor-constants";
import { useSelectableConnectionProviders } from "@/domains/settings/ai/provider-availability";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
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

  // Seed the user-facing label and internal name from the provider type,
  // deduped against existing provider names.
  const initialDefaults = deriveProviderDefaults(
    initialProvider,
    existingNames,
  );

  const [label, setLabel] = useState(initialDefaults.name);
  const [name, setName] = useState(initialDefaults.key);
  // The picker offers real connection providers plus "chatgpt", a
  // subscription-auth pseudo-provider: its connection is created by the OAuth
  // sign-in flow rather than this form's Save.
  const [selected, setSelected] = useState<ConnectionProvider | "chatgpt">(
    initialProvider,
  );
  const isChatgpt = selected === "chatgpt";
  const provider: ConnectionProvider = isChatgpt ? "openai" : selected;
  // Auth is derived from the provider, never user-chosen: ollama is keyless,
  // ChatGPT is subscription (OAuth), everything else authenticates by API key.
  const authType: Auth["type"] = isChatgpt
    ? "oauth_subscription"
    : provider === "ollama"
      ? "none"
      : "api_key";
  const [credential, setCredential] = useState(() =>
    initialProvider === "ollama" ? "" : `credential/${initialProvider}/api_key`,
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [connectionModels, setConnectionModels] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);

  const isOpenAICompatible = provider === "openai-compatible";
  const connectionProviderOptions = useMemo<
    Array<ConnectionProvider | "chatgpt">
  >(() => {
    const base: Array<ConnectionProvider | "chatgpt"> =
      !isChatgpt && !selectableConnectionProviders.includes(provider)
        ? [...selectableConnectionProviders, provider]
        : [...selectableConnectionProviders];
    // Subscription-auth entry, right after its API-key sibling.
    const openaiIndex = base.indexOf("openai");
    if (openaiIndex >= 0) {
      base.splice(openaiIndex + 1, 0, "chatgpt");
    }
    return base;
  }, [isChatgpt, provider, selectableConnectionProviders]);

  const isLabelDirty = useRef(false);

  function handleLabelChange(newLabel: string) {
    isLabelDirty.current = true;
    setLabel(newLabel);
  }

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
  const { credentials: availableCredentials } = useProviderCredentialsList({
    assistantId,
    enabled: true,
  });

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
          auth = { type: "api_key", credential: effectiveCredential };
        } else if (hasStoredCredential) {
          auth = { type: "api_key", credential: effectiveCredential };
        } else if (isOpenAICompatible) {
          // Custom endpoints have no fixed auth story: local servers are
          // usually keyless. No key entered → keyless auth.
          auth = { type: "none" };
        } else {
          setError("Enter an API key or select an existing credential.");
          return;
        }
      } else if (authType === "oauth_subscription") {
        // OAuth subscription connections are created by the OAuth flow
        // (ChatgptOAuthSection), not through Save.
        setError(
          'Use the "Sign in with ChatGPT" button to connect your subscription.',
        );
        return;
      } else {
        auth = { type: "none" };
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
      const { data: created, response: createRes } =
        await inferenceProviderconnectionsPost({
          path: { assistant_id: assistantId },
          body: input,
        });
      if (!createRes?.ok) {
        setError(connectionSaveErrorMessage(createRes?.status));
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
      setError("Failed to save provider. Please try again.");
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

  // Display Name is optional and rarely needs editing.
  const detailsOpen = isDetailsExpanded;

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
          value={selected}
          onChange={(newSelected) => {
            setSelected(newSelected);
            setError(null);
            if (newSelected === "chatgpt") {
              return;
            }
            // Internal names always follow the selected provider. Preserve a
            // user-edited Display Name across provider changes.
            const { name: seedName, key: seedKey } = deriveProviderDefaults(
              newSelected,
              existingNames,
            );
            if (!isLabelDirty.current) {
              setLabel(seedName);
            }
            setName(seedKey);
            setCredential(
              newSelected === "ollama"
                ? ""
                : `credential/${newSelected}/api_key`,
            );
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

      {/* API Key + Advanced disclosure — only shown for key-based providers */}
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

      {!isChatgpt && advancedDetailsSection}

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
      {!isChatgpt && (
        <Button
          variant="primary"
          size="compact"
          disabled={!canSave || saving || isSavingKey}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Add"}
        </Button>
      )}
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
        <Modal.Title>Add Provider</Modal.Title>
        <Modal.Description>
          Choose a provider and paste its API key.
        </Modal.Description>
      </Modal.Header>

      <Modal.Body>{body}</Modal.Body>

      <Modal.Footer>{footer}</Modal.Footer>
    </Modal.Content>
  );
}
