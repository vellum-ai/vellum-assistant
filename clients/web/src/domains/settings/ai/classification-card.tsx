/**
 * Settings → AI card for the classification family: the decision model the
 * voice judges and memory pool selection consult. Reads and writes
 * `services.classification` ({ mode, provider, model }) and stores the
 * provider's API key through the credential store, mirroring the STT form.
 */

import { useCallback, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ByoServiceCard } from "@/components/byo-service-card";
import {
  CredentialsGuide,
  SaveButton,
} from "@/components/service-form-controls";
import {
  classificationProvidersGetOptions,
  classificationProvidersGetQueryKey,
  configGetOptions,
  configGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { configPatch, credentialsSetPost } from "@/generated/daemon/sdk.gen";
import type { ClassificationProvidersGetResponse } from "@/generated/daemon/types.gen";
import { useDraftOverride } from "@/hooks/use-draft-override";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { Input } from "@vellumai/design-library/components/input";
import { Select } from "@vellumai/design-library/components/select";
import { toast } from "@vellumai/design-library/components/toast";

type ClassificationMode = "managed" | "your-own";
type CatalogProvider = ClassificationProvidersGetResponse["providers"][number];
type Availability = ClassificationProvidersGetResponse["availability"];

/** Mirrors the daemon's `services.classification` schema defaults. */
const DEFAULT_MODE: ClassificationMode = "your-own";

export function ClassificationCard() {
  const { t } = useTranslation("settings");
  return (
    <ByoServiceCard
      title={t("classificationCard.title")}
      subtitle={t("classificationCard.subtitle")}
    >
      <ClassificationProviderForm />
    </ByoServiceCard>
  );
}

type StatusKey =
  | "classificationCard.statusManaged"
  | "classificationCard.statusUserKey"
  | "classificationCard.statusMissingCredential"
  | "classificationCard.statusPlatformUnavailable"
  | "classificationCard.statusUnavailable";

function statusKey(availability: Availability | undefined): StatusKey | null {
  if (!availability) {
    return null;
  }
  if (availability.available) {
    return availability.source === "managed-proxy"
      ? "classificationCard.statusManaged"
      : "classificationCard.statusUserKey";
  }
  switch (availability.reason) {
    case "missing_credential":
      return "classificationCard.statusMissingCredential";
    case "platform_unavailable":
      return "classificationCard.statusPlatformUnavailable";
    default:
      return "classificationCard.statusUnavailable";
  }
}

function ClassificationProviderForm() {
  const assistantId = useActiveAssistantId();
  const isOrgReady = useIsOrgReady();
  const queryClient = useQueryClient();
  const { t } = useTranslation("settings");

  const { data: catalog } = useQuery({
    ...classificationProvidersGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });

  const providers: CatalogProvider[] = useMemo(
    () => catalog?.providers ?? [],
    [catalog],
  );
  // `services.classification` falls under the ConfigGetResponse index
  // signature (`unknown`), so narrow it explicitly.
  const daemonClassification = daemonConfig?.services?.classification as
    | { mode?: ClassificationMode; provider?: string; model?: string }
    | undefined;

  const serverProvider =
    daemonClassification?.provider ?? providers[0]?.id ?? "";
  const serverMode: ClassificationMode =
    daemonClassification?.mode ?? DEFAULT_MODE;

  const [draftProvider, setDraftProvider] = useDraftOverride(serverProvider);
  const [draftMode, setDraftMode] = useDraftOverride(serverMode);
  const [apiKeyText, setApiKeyText] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedProvider = providers.find((p) => p.id === draftProvider);
  // Managed routing is only offered where the platform fronts the provider;
  // a draft that lands on a BYOK-only provider snaps back to your-own.
  const supportsManaged = selectedProvider?.supportsManaged === true;
  const effectiveMode: ClassificationMode = supportsManaged
    ? draftMode
    : "your-own";
  const requiresApiKey = effectiveMode === "your-own";
  const trimmedKey = apiKeyText.trim();
  const hasChanges =
    draftProvider !== serverProvider ||
    effectiveMode !== serverMode ||
    (requiresApiKey && trimmedKey.length > 0);

  const handleSave = useCallback(async () => {
    if (!selectedProvider) {
      return false;
    }
    setSaving(true);
    try {
      if (requiresApiKey && trimmedKey.length > 0) {
        const { response: keyRes } = await credentialsSetPost({
          path: { assistant_id: assistantId },
          body: {
            service: selectedProvider.apiKeyProviderName,
            field: "api_key",
            value: trimmedKey,
            label: `${selectedProvider.displayName} API Key`,
          },
          throwOnError: false,
        });
        if (!keyRes?.ok) {
          throw new Error(
            `Failed to store API key (HTTP ${keyRes?.status ?? "?"})`,
          );
        }
      }
      const { response: cfgRes } = await configPatch({
        path: { assistant_id: assistantId },
        body: {
          services: {
            classification: {
              mode: effectiveMode,
              provider: selectedProvider.id,
              model: selectedProvider.defaultModel,
            },
          },
        },
        throwOnError: false,
      });
      if (!cfgRes?.ok) {
        throw new Error(
          `Failed to save configuration (HTTP ${cfgRes?.status ?? "?"})`,
        );
      }
      setApiKeyText("");
      const path = { assistant_id: assistantId };
      void queryClient.invalidateQueries({
        queryKey: configGetQueryKey({ path }),
      });
      void queryClient.invalidateQueries({
        queryKey: classificationProvidersGetQueryKey({ path }),
      });
      toast.success(t("classificationCard.saveSuccess"));
      return true;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("classificationCard.saveFailed"),
      );
      return false;
    } finally {
      setSaving(false);
    }
  }, [
    assistantId,
    effectiveMode,
    queryClient,
    requiresApiKey,
    selectedProvider,
    t,
    trimmedKey,
  ]);

  const modeOptions = [
    ...(supportsManaged
      ? [{ value: "managed", label: t("classificationCard.modeManaged") }]
      : []),
    { value: "your-own", label: t("classificationCard.modeYourOwn") },
  ];
  const key = statusKey(catalog?.availability);
  const status = key ? t(key) : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          {t("classificationCard.providerLabel")}
        </label>
        <Select
          value={draftProvider}
          onChange={setDraftProvider}
          options={providers.map((p) => ({
            value: p.id,
            label: p.displayName,
          }))}
          aria-label={t("classificationCard.providerAriaLabel")}
        />
        {selectedProvider && (
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {selectedProvider.subtitle}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          {t("classificationCard.modeLabel")}
        </label>
        <Select
          value={effectiveMode}
          onChange={(value) => setDraftMode(value as ClassificationMode)}
          options={modeOptions}
          aria-label={t("classificationCard.modeAriaLabel")}
        />
      </div>

      {requiresApiKey && (
        <div className="space-y-1">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("classificationCard.apiKeyLabel")}
          </label>
          <Input
            type="password"
            value={apiKeyText}
            onChange={(e) => setApiKeyText(e.target.value)}
            placeholder={
              catalog?.availability.available &&
              catalog.availability.source === "user-key"
                ? t("classificationCard.apiKeyPlaceholderReplace")
                : t("classificationCard.apiKeyPlaceholder")
            }
            fullWidth
          />
        </div>
      )}

      {requiresApiKey && selectedProvider && (
        <CredentialsGuide guide={selectedProvider.credentialsGuide} />
      )}

      {status && (
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {status}
        </p>
      )}

      <div className="flex items-center gap-2">
        <SaveButton onClick={handleSave} disabled={!hasChanges || saving} />
      </div>
    </div>
  );
}
