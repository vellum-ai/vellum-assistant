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
  classificationProvidersGetQueryKey,
  configGetOptions,
  configGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  classificationProvidersGet,
  configPatch,
  secretsPost,
} from "@/generated/daemon/sdk.gen";
import type { ClassificationProvidersGetResponse } from "@/generated/daemon/types.gen";
import { useDraftOverride } from "@/hooks/use-draft-override";
import { toApiError } from "@/utils/api-errors";
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

/**
 * The classification catalog, or `null` when the assistant predates
 * `GET /v1/classification/providers`. The web bundle can be newer than the
 * connected assistant; against one without the route the request 404s, and
 * the card's feature-off state is to render nothing. Mapped here rather than
 * thrown so React Query does not strand a stale success across a rollback
 * (see `docs/BACKWARDS_COMPAT.md`, "When a gate is unnecessary"). Every
 * write the card performs goes to routes every assistant serves, so no
 * version gate is needed.
 */
async function fetchClassificationCatalog(
  assistantId: string,
  signal: AbortSignal,
): Promise<ClassificationProvidersGetResponse | null> {
  const { data, error, response } = await classificationProvidersGet({
    path: { assistant_id: assistantId },
    signal,
    throwOnError: false,
  });
  if (!response || !response.ok) {
    if (response?.status === 404) {
      return null;
    }
    if (response) {
      throw toApiError(error, response);
    }
    throw error instanceof Error
      ? error
      : new Error("Failed to load classification providers.");
  }
  return data ?? null;
}

export function ClassificationCard() {
  const assistantId = useActiveAssistantId();
  const isOrgReady = useIsOrgReady();
  const { t } = useTranslation("settings");
  const { data: catalog } = useQuery({
    queryKey: classificationProvidersGetQueryKey({
      path: { assistant_id: assistantId },
    }),
    queryFn: ({ signal }) => fetchClassificationCatalog(assistantId, signal),
    enabled: isOrgReady,
    staleTime: 30_000,
    // Changes arrive through Save's own invalidation; against an assistant
    // without the route a focus refetch would only repeat the 404.
    refetchOnWindowFocus: false,
  });
  // `undefined` while loading, `null` when the assistant lacks the family:
  // both render as feature-off rather than as empty controls.
  if (!catalog) {
    return null;
  }
  return (
    <ByoServiceCard
      title={t("classificationCard.title")}
      subtitle={t("classificationCard.subtitle")}
    >
      <ClassificationProviderForm assistantId={assistantId} catalog={catalog} />
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

function ClassificationProviderForm({
  assistantId,
  catalog,
}: {
  assistantId: string;
  catalog: ClassificationProvidersGetResponse;
}) {
  const isOrgReady = useIsOrgReady();
  const queryClient = useQueryClient();
  const { t } = useTranslation("settings");

  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });

  const providers: CatalogProvider[] = useMemo(
    () => catalog.providers,
    [catalog],
  );
  // `services.classification` falls under the ConfigGetResponse index
  // signature (`unknown`), so narrow it explicitly.
  const daemonClassification = daemonConfig?.services?.classification as
    | {
        mode?: ClassificationMode;
        provider?: string;
        model?: string;
        credential?: string | null;
      }
    | undefined;

  const serverProvider =
    daemonClassification?.provider ?? providers[0]?.id ?? "";
  const serverModel =
    typeof daemonClassification?.model === "string" &&
    daemonClassification.model.length > 0
      ? daemonClassification.model
      : undefined;
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
        // The provider-aware secrets route validates the key upstream before
        // storing it. A rejected key comes back as 200 with success:false and
        // is NOT stored, so the config must not be pointed at it.
        const { data: keyData, response: keyRes } = await secretsPost({
          path: { assistant_id: assistantId },
          body: {
            type: "api_key",
            name: selectedProvider.apiKeyProviderName,
            value: trimmedKey,
          },
          throwOnError: false,
        });
        if (!keyRes?.ok) {
          throw new Error(
            `Failed to store API key (HTTP ${keyRes?.status ?? "?"})`,
          );
        }
        if (keyData && keyData.success === false) {
          throw new Error(keyData.error ?? t("classificationCard.keyRejected"));
        }
      }
      // Keep a configured model when the provider stays the same: a key
      // replacement or a mode flip must not reset a model the user (or the
      // profile migration) chose. The catalog default applies only when the
      // provider changes or nothing is configured yet.
      const model =
        selectedProvider.id === daemonClassification?.provider && serverModel
          ? serverModel
          : selectedProvider.defaultModel;
      // A key typed here lands in the provider's canonical credential slot.
      // A migrated workspace may still point `credential` at a custom
      // account, which would keep serving the old key, so clear it whenever
      // a replacement was stored (the daemon treats null as unset).
      const clearCredential =
        requiresApiKey &&
        trimmedKey.length > 0 &&
        !!daemonClassification?.credential;
      const { response: cfgRes } = await configPatch({
        path: { assistant_id: assistantId },
        body: {
          services: {
            classification: {
              mode: effectiveMode,
              provider: selectedProvider.id,
              model,
              ...(clearCredential ? { credential: null } : {}),
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
    daemonClassification?.credential,
    daemonClassification?.provider,
    effectiveMode,
    queryClient,
    requiresApiKey,
    selectedProvider,
    serverModel,
    t,
    trimmedKey,
  ]);

  const modeOptions = [
    ...(supportsManaged
      ? [{ value: "managed", label: t("classificationCard.modeManaged") }]
      : []),
    { value: "your-own", label: t("classificationCard.modeYourOwn") },
  ];
  const key = statusKey(catalog.availability);
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
              catalog.availability.available &&
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
