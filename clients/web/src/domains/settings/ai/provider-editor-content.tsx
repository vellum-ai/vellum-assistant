import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

import { Trans, useTranslation } from "@/i18n";
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
import {
  CUSTOM_PROVIDER_NAME_ERRORS,
  customProviderNameConflict,
} from "@/domains/settings/ai/custom-provider-names";
import { ProviderCreateForm } from "@/domains/settings/ai/provider-create-form";
import { ProviderEditorApiKeySection } from "@/domains/settings/ai/provider-editor-api-key-section";
import {
  connectionSaveErrorMessage,
  parseCredentialRef,
  providerAllowsCustomBaseUrl,
  providerConnectionDisplayName,
  validationErrorMessage,
  warnOnFailedEndpointCheck,
} from "@/domains/settings/ai/provider-editor-constants";
import { secretPlaceholder } from "@/domains/settings/ai/secret-placeholder";
import { useProviderCredentialsList } from "@/domains/settings/ai/use-provider-credentials-list";

// ---------------------------------------------------------------------------
// ProviderEditorContent
// ---------------------------------------------------------------------------

export interface ProviderEditorContentProps {
  mode: "create" | "edit";
  connection?: ProviderConnection;
  assistantId: string;
  existingNames: string[];
  /** Existing connections, for custom-provider name-collision checks. */
  connections?: ProviderConnection[];
  /**
   * Host chrome, mirroring ProviderCreateForm's variants: `"modal"` renders
   * a full `Modal.Content` (header + body + footer) for embedding in a
   * host's `Modal.Root`; `"panel"` renders the bare fields + action row for
   * the settings sidepanel (DetailShell body).
   */
  variant?: "modal" | "panel";
  /**
   * Where the Cancel/Save row renders, for `variant="panel"` hosts that pin
   * their actions outside the scrollable body (see `DetailShell`'s `footer`).
   * Omit to keep the row inline at the end of the fields; pass the element to
   * portal into it. `null` means the host's slot has not mounted yet, so the
   * row is withheld for that one commit rather than rendered in both places.
   */
  actionsSlot?: HTMLElement | null;
  onSave: (connection: ProviderConnection) => void;
  onCancel: () => void;
}

export function ProviderEditorContent({
  mode,
  connection,
  assistantId,
  existingNames,
  connections,
  variant = "modal",
  actionsSlot,
  onSave,
  onCancel,
}: ProviderEditorContentProps) {
  const { t } = useTranslation("settings");
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
  const allowsCustomBaseUrl = providerAllowsCustomBaseUrl(provider);

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
  // A custom provider must not take a built-in provider's name or another
  // custom provider's — mirrors the daemon's route-side validation.
  // Only a changed label is validated — keeping the stored label must never
  // lock the row out of unrelated edits (key rotation).
  const labelChanged = label.trim() !== (connection?.label ?? "").trim();
  const nameConflict =
    isOpenAICompatible && labelChanged
      ? customProviderNameConflict(label, connections, connection?.name)
      : null;
  const canSave = name.trim().length > 0 && nameConflict === null;

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
            setError(t("providerEditorContent.failedSaveApiKey"));
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
        setError(t("providerEditorContent.nothingToEdit"));
        return;
      }

      const labelValue = label.trim() || null;

      // Edit only — create mode is handled by ProviderCreateForm (see the
      // early return above), which owns the POST path. This component never
      // reaches handleSave in create mode.
      const input: InferenceProviderconnectionsByNamePatchData["body"] = {
        auth,
        label: labelValue,
        ...(allowsCustomBaseUrl && {
          base_url: baseUrl.trim() || null,
        }),
        ...(isOpenAICompatible && {
          models: connectionModels.trim()
            ? connectionModels
                .split(",")
                .map((id) => ({ id: id.trim() }))
                .filter((m) => m.id)
            : null,
        }),
      };
      const {
        data: updated,
        error: updateErr,
        response: updateRes,
      } = await inferenceProviderconnectionsByNamePatch({
        path: {
          assistant_id: assistantId,
          name: connection?.name ?? name.trim(),
        },
        body: input,
      });
      if (!updateRes?.ok) {
        setError(
          validationErrorMessage(updateRes?.status, updateErr) ??
            connectionSaveErrorMessage(updateRes?.status),
        );
        return;
      }
      if (!updated) {
        setError(t("providerEditorContent.emptyServerResponse"));
        return;
      }
      warnOnFailedEndpointCheck(updated, t);
      onSave(updated);
    } catch {
      setError(t("providerEditorContent.failedSaveProvider"));
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
    t("providerEditorContent.apiKeyPlaceholder"),
    hasStoredCredential,
  );

  // Create mode is fully owned by the shared ProviderCreateForm. It carries
  // the create-path submit sequence (secretsPost →
  // inferenceProviderconnectionsPost) and renders chrome per variant.
  // Edit falls through below.
  if (mode === "create") {
    return (
      <ProviderCreateForm
        variant={variant === "panel" ? "inline" : "modal"}
        actionsSlot={actionsSlot}
        assistantId={assistantId}
        existingNames={existingNames}
        connections={connections}
        defaultProviderType={provider}
        onCreated={onSave}
        onCancel={onCancel}
      />
    );
  }

  const body = (
    <div className="space-y-4">
        {/* Display Name */}
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            <Trans
              i18nKey="providerEditorContent.displayNameLabel"
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
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("providerEditorContent.displayNamePlaceholder")}
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

        {allowsCustomBaseUrl && (
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              {t("providerEditorContent.baseUrlLabel")}
            </label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={
                provider === "ollama"
                  ? t("providerEditorContent.baseUrlPlaceholderOllama")
                  : t("providerEditorContent.baseUrlPlaceholder")
              }
              fullWidth
            />
            {provider === "ollama" ? (
              <Typography
                variant="body-small-default"
                as="p"
                className="text-[var(--content-tertiary)]"
              >
                {t("providerEditorContent.baseUrlHintOllama")}
              </Typography>
            ) : null}
          </div>
        )}
        {isOpenAICompatible && (
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              {t("providerEditorContent.modelsLabel")}
            </label>
            <Input
              value={connectionModels}
              onChange={(e) => setConnectionModels(e.target.value)}
              placeholder={t("providerEditorContent.modelsPlaceholder")}
              fullWidth
            />
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              {t("providerEditorContent.modelsHint")}
            </Typography>
          </div>
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
    </div>
  );

  const footer = (
    <>
      <Button variant="ghost" onClick={onCancel}>
        {t("providerEditorContent.cancel")}
      </Button>
      <Button
        variant="primary"
        disabled={!canSave || saving || isSavingKey}
        onClick={() => void handleSave()}
      >
        {saving
          ? t("providerEditorContent.saving")
          : t("providerEditorContent.saveChanges")}
      </Button>
    </>
  );

  if (variant === "panel") {
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
        <Modal.Title>{t("providerEditorContent.editProviderTitle")}</Modal.Title>
        <Modal.Description>
          {connection
            ? t("providerEditorContent.editingConnection", {
                name: providerConnectionDisplayName(connection),
              })
            : t("providerEditorContent.editProviderSettingsFallback")}
        </Modal.Description>
      </Modal.Header>

      <Modal.Body>{body}</Modal.Body>

      <Modal.Footer>{footer}</Modal.Footer>
    </Modal.Content>
  );
}
