import { useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Select } from "@vellumai/design-library/components/select";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";
import { ChevronRight } from "lucide-react";

import { Trans, useTranslation } from "@/i18n";
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
import {
  CUSTOM_PROVIDER_NAME_ERRORS,
  customProviderNameConflict,
} from "@/domains/settings/ai/custom-provider-names";
import { deriveProviderDefaults } from "@/domains/settings/ai/profile-prefill";
import type {
  Auth,
  ConnectionProvider,
  InferenceProviderconnectionsPostData,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { ProviderEditorApiKeySection } from "@/domains/settings/ai/provider-editor-api-key-section";
import {
  CONNECTION_PROVIDERS,
  connectionAuthTypeForProvider,
  connectionSaveErrorMessage,
  parseCredentialRef,
  providerAllowsCustomBaseUrl,
  providerPersistsConnectionModels,
  validationErrorMessage,
  warnOnFailedEndpointCheck,
} from "@/domains/settings/ai/provider-editor-constants";
import { useSelectableConnectionProviders } from "@/domains/settings/ai/provider-availability";
import { useProviderPickerAvailability } from "@/domains/settings/ai/provider-picker-availability";
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
  /** Existing connections, for custom-provider name-collision checks. */
  connections?: ProviderConnection[];
  /** Pre-selected provider type. */
  defaultProviderType?: ConnectionProvider;
  /**
   * Hide the form's own provider selector. For hosts whose surrounding UI
   * already names the provider (a picker that preselected it via
   * `defaultProviderType`), rendering it again reads as a duplicate field.
   */
  hideProviderSelect?: boolean;
  onCreated: (connection: ProviderConnection) => void;
  onCancel: () => void;
  /** "modal" wraps the form in Modal chrome; "inline" drops it for embedding. */
  variant?: "modal" | "inline";
  /**
   * Where the Cancel/Add row renders, for `variant="inline"` hosts that pin
   * their actions outside the scrollable body (see `DetailShell`'s `footer`).
   * Omit to keep the row inline at the end of the fields; pass the element to
   * portal into it. `null` means the host's slot has not mounted yet, so the
   * row is withheld for that one commit rather than rendered in both places.
   */
  actionsSlot?: HTMLElement | null;
}

export function ProviderCreateForm({
  assistantId,
  existingNames,
  connections,
  defaultProviderType,
  hideProviderSelect = false,
  onCreated,
  onCancel,
  variant = "modal",
  actionsSlot,
}: ProviderCreateFormProps) {
  const { t } = useTranslation("settings");
  const selectableConnectionProviders = useSelectableConnectionProviders();
  const providerAvailability = useProviderPickerAvailability();
  // A provider this assistant cannot reach is offered as a disabled row, so
  // the seed and the empty-picker fallback both land on one it can.
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

  const [label, setLabel] = useState(
    initialProvider === "openai-compatible" ? "" : initialDefaults.name,
  );
  const [name, setName] = useState(initialDefaults.key);
  // The picker offers real connection providers plus "chatgpt", a
  // subscription-auth pseudo-provider: its connection is created by the OAuth
  // sign-in flow rather than this form's Save.
  const [selected, setSelected] = useState<ConnectionProvider | "chatgpt">(
    initialProvider,
  );
  const isChatgpt = selected === "chatgpt";
  const provider: ConnectionProvider = isChatgpt ? "openai" : selected;
  // Auth is derived from the provider, never user-chosen: ChatGPT is
  // subscription (OAuth), everything else follows the provider's connection
  // auth (ollama keyless, the rest API key).
  const authType: Auth["type"] = isChatgpt
    ? "oauth_subscription"
    : connectionAuthTypeForProvider(provider);
  // Custom providers get per-connection credential slots: keying the ref by
  // the provider type would share ONE vault slot across every custom
  // endpoint, so saving any endpoint's key overwrites the others'.
  const [credential, setCredential] = useState(() =>
    initialProvider === "ollama"
      ? ""
      : initialProvider === "openai-compatible"
        ? `credential/${initialDefaults.key}/api_key`
        : `credential/${initialProvider}/api_key`,
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [connectionModels, setConnectionModels] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);

  const isOpenAICompatible = provider === "openai-compatible";
  const allowsCustomBaseUrl = providerAllowsCustomBaseUrl(provider);
  const persistsConnectionModels = providerPersistsConnectionModels(provider);
  const connectionProviderOptions = useMemo<
    Array<ConnectionProvider | "chatgpt">
  >(() => {
    const base: Array<ConnectionProvider | "chatgpt"> =
      !isChatgpt && !CONNECTION_PROVIDERS.includes(provider)
        ? [...CONNECTION_PROVIDERS, provider]
        : [...CONNECTION_PROVIDERS];
    // Subscription-auth entry, right after its API-key sibling.
    const openaiIndex = base.indexOf("openai");
    if (openaiIndex >= 0) {
      base.splice(openaiIndex + 1, 0, "chatgpt");
    }
    return base;
  }, [isChatgpt, provider]);

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

  // A custom provider must not take a built-in provider's name or another
  // custom provider's — entries share one flat list. Mirrors the daemon's
  // route-side validation for inline feedback.
  const nameConflict = isOpenAICompatible
    ? customProviderNameConflict(label, connections)
    : null;
  const canSave =
    name.trim().length > 0 &&
    (!isOpenAICompatible || label.trim().length > 0) &&
    nameConflict === null;

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
          credential.trim() ||
          `credential/${isOpenAICompatible ? name : provider}/api_key`;
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
            setError(t("providerCreateForm.failedSaveApiKey"));
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
          setError(t("providerCreateForm.enterApiKeyOrCredential"));
          return;
        }
      } else if (authType === "oauth_subscription") {
        // OAuth subscription connections are created by the OAuth flow
        // (ChatgptOAuthSection), not through Save.
        setError(t("providerCreateForm.useChatgptSignIn"));
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
        ...(allowsCustomBaseUrl && {
          base_url: baseUrl.trim() || null,
        }),
        ...(persistsConnectionModels && {
          models: connectionModels.trim()
            ? connectionModels
                .split(",")
                .map((id) => ({ id: id.trim() }))
                .filter((m) => m.id)
            : null,
        }),
      };
      const {
        data: created,
        error: createErr,
        response: createRes,
      } = await inferenceProviderconnectionsPost({
        path: { assistant_id: assistantId },
        body: input,
      });
      if (!createRes?.ok) {
        setError(
          validationErrorMessage(createRes?.status, createErr) ??
            connectionSaveErrorMessage(createRes?.status),
        );
        return;
      }
      if (!created) {
        setError(t("providerCreateForm.emptyServerResponse"));
        return;
      }
      // Single success confirmation for both the standalone and inline
      // surfaces; failures above already surface inline via `error` (no toast).
      toast.success(t("providerCreateForm.providerConnectedToast"));
      warnOnFailedEndpointCheck(created, t);
      onCreated(created);
    } catch {
      setError(t("providerCreateForm.failedSaveProvider"));
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
    t("providerCreateForm.apiKeyPlaceholder"),
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
        <span>{t("providerCreateForm.advanced")}</span>
      </button>

      {detailsOpen && (
        <div className="mt-2 space-y-4">
          {/* Display Name */}
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              <Trans
                i18nKey="providerCreateForm.displayNameLabel"
                ns="settings"
                components={{
                  optional: (
                    <span className="text-[var(--content-disabled)]" />
                  ),
                }}
              />
            </label>
            <Input
              value={label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder={t("providerCreateForm.displayNamePlaceholder")}
              fullWidth
            />
          </div>
        </div>
      )}
    </div>
  );

  const body = (
    <div className="space-y-4">
      {/* Provider — omitted when the host's own picker already fixed it. */}
      {!hideProviderSelect && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("providerCreateForm.providerLabel")}
          </label>
          <Select
            aria-label={t("providerCreateForm.providerAriaLabel")}
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
                // A custom provider's name is the user's identity for it —
                // seeding the protocol's display name would produce
                // "Add OpenAI-compatible".
                setLabel(newSelected === "openai-compatible" ? "" : seedName);
              }
              setName(seedKey);
              setCredential(
                newSelected === "ollama"
                  ? ""
                  : newSelected === "openai-compatible"
                    ? `credential/${seedKey}/api_key`
                    : `credential/${newSelected}/api_key`,
              );
              // Credential ref changes above trigger a new TQ query key,
              // so the presence check auto-refetches for the new provider.
            }}
            options={[
              // Catalog providers first; the custom-provider entry closes the
              // list, pinned to the menu's bottom edge so the catalog can
              // scroll past it. "OpenAI-compatible" is the protocol a custom
              // provider must speak, not the provider's identity.
              ...connectionProviderOptions
                .filter((p) => p !== "openai-compatible")
                .map((p) => ({
                  value: p,
                  label: PROVIDER_DISPLAY_NAMES[p],
                  ...providerAvailability(p),
                })),
              ...(connectionProviderOptions.includes("openai-compatible")
                ? [
                    {
                      value: "openai-compatible" as ConnectionProvider,
                      label: t("providerCreateForm.customProviderOption"),
                      sticky: true,
                    },
                  ]
                : []),
            ]}
          />
          {isOpenAICompatible ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              {t("providerCreateForm.customProviderHint")}
            </Typography>
          ) : null}
        </div>
      )}

      {/* Name + Models: custom providers only. Name leads: the user is
          adding "xAI", not configuring a URL. Base URL is shared with
          ollama, which treats an empty value as the local default. */}
      {isOpenAICompatible && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("providerCreateForm.nameLabel")}
          </label>
          <Input
            value={label}
            onChange={(e) => handleLabelChange(e.target.value)}
            placeholder={t("providerCreateForm.namePlaceholder")}
            fullWidth
          />
          {nameConflict ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-(--system-negative-strong)"
            >
              {CUSTOM_PROVIDER_NAME_ERRORS[nameConflict]}
            </Typography>
          ) : null}
        </div>
      )}
      {allowsCustomBaseUrl && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("providerCreateForm.baseUrlLabel")}
          </label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              provider === "ollama"
                ? t("providerCreateForm.baseUrlPlaceholderOllama")
                : provider === "opencode"
                  ? t("providerCreateForm.baseUrlPlaceholderOpencode")
                  : t("providerCreateForm.baseUrlPlaceholder")
            }
            fullWidth
          />
          {provider === "ollama" ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              {t("providerCreateForm.baseUrlHintOllama")}
            </Typography>
          ) : null}
          {provider === "opencode" ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              {t("providerCreateForm.baseUrlHintOpencode")}
            </Typography>
          ) : null}
        </div>
      )}
      {persistsConnectionModels && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("providerCreateForm.modelsLabel")}
          </label>
          <Input
            value={connectionModels}
            onChange={(e) => setConnectionModels(e.target.value)}
            placeholder={t("providerCreateForm.modelsPlaceholder")}
            fullWidth
          />
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-tertiary)]"
          >
            {t("providerCreateForm.modelsHint")}
          </Typography>
        </div>
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

      {isOpenAICompatible && authType === "api_key" ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          {t("providerCreateForm.localEndpointHint")}
        </Typography>
      ) : null}

      {/* ChatGPT Subscription OAuth — shown when auth type is oauth_subscription */}
      {authType === "oauth_subscription" && (
        <ChatgptOAuthSection
          assistantId={assistantId}
          onConnected={onCreated}
        />
      )}

      {!isChatgpt && !isOpenAICompatible && advancedDetailsSection}

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
      <Button variant="ghost" onClick={onCancel}>
        {t("providerCreateForm.cancel")}
      </Button>
      {!isChatgpt && (
        <Button
          variant="primary"
          disabled={!canSave || saving || isSavingKey}
          onClick={() => void handleSave()}
        >
          {saving
            ? t("providerCreateForm.saving")
            : isOpenAICompatible && label.trim()
              ? t("providerCreateForm.addNamed", { name: label.trim() })
              : t("providerCreateForm.add")}
        </Button>
      )}
    </>
  );

  if (variant === "inline") {
    return (
      <div className="space-y-4">
        {body}
        {actionsSlot === undefined ? (
          <div className="flex justify-end gap-2">{footer}</div>
        ) : (
          actionsSlot && createPortal(footer, actionsSlot)
        )}
      </div>
    );
  }

  return (
    <Modal.Content size="md">
      <Modal.Header>
        <Modal.Title>{t("providerCreateForm.addProviderTitle")}</Modal.Title>
        <Modal.Description>
          {t("providerCreateForm.addProviderDescription")}
        </Modal.Description>
      </Modal.Header>

      <Modal.Body>{body}</Modal.Body>

      <Modal.Footer>{footer}</Modal.Footer>
    </Modal.Content>
  );
}
