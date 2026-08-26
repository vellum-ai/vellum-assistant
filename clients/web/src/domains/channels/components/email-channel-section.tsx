import { CircleCheck, ExternalLink, Info, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import { credentialsInspectPost } from "@/generated/daemon/sdk.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { usePlatformAssistantId } from "@/hooks/use-platform-assistant-id";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { useEnvironmentStore } from "@/stores/environment-store";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { Select } from "@vellumai/design-library/components/select";
import { toast } from "@vellumai/design-library/components/toast";

import { Trans, useTranslation } from "@/i18n";
import { ByoServiceCard } from "@/components/byo-service-card";
import { ServiceCard } from "@/components/service-card";
import { SaveButton } from "@/components/service-form-controls";
import {
  LS_EMAIL_BYO_PROVIDER,
  LS_EMAIL_MODE,
} from "@/utils/local-settings-keys";
import type { EmailByoProvider } from "@/lib/provider-catalogs";
import { EMAIL_BYO_PROVIDERS } from "@/lib/provider-catalogs";
import { parseServiceMode } from "@/domains/channels/service-mode";
import type { ServiceMode } from "@/generated/daemon/types.gen";
import { EmailManagedContent } from "@/domains/channels/components/email-managed-content";

export function EmailChannelSection() {
  const { t } = useTranslation("channels");
  const assistantId = useActiveAssistantId();

  // assistantHandle is platform-only; used to pre-fill the email subdomain.
  const isOrgReady = useIsOrgReady();
  const { data: assistantList } = useQuery({
    ...assistantsListOptions(),
    enabled: isOrgReady,
  });
  const assistantHandle = assistantList?.results?.[0]?.handle;

  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const platformGate = usePlatformGate();

  const [mode, setMode] = useState<ServiceMode>(() => {
    if (platformGate === "gated") {
      return "your-own";
    }
    return parseServiceMode(
      getLocalSetting(LS_EMAIL_MODE, "managed"),
      "managed",
    );
  });
  const [byoProviderId, setByoProviderId] = useState<EmailByoProvider["id"]>(
    () => {
      const raw = getLocalSetting(LS_EMAIL_BYO_PROVIDER, "resend");
      return raw === "mailgun" || raw === "resend" ? raw : "resend";
    },
  );

  // Managed email lives on the platform API, whose assistant routes key on
  // the platform UUID — the local-mode lockfile id is a slug that no
  // platform route matches. Resolve the platform id before rendering the
  // managed form; on resolution failure fall back to the raw id so the
  // platform can still answer with a real per-request error.
  const { platformAssistantId, error: platformAssistantIdError } =
    usePlatformAssistantId(
      assistantId,
      platformGate === "full" && mode === "managed",
    );
  const managedAssistantId =
    platformAssistantId ?? (platformAssistantIdError ? assistantId : null);

  // -- BYO credential check (your-own mode) ----------------------------------
  const byoCredentialQuery = useQuery({
    queryKey: ["byoEmailCredential", assistantId, byoProviderId],
    queryFn: async () => {
      const { data } = await credentialsInspectPost({
        path: { assistant_id: assistantId },
        body: { service: byoProviderId, field: "api_key" },
        throwOnError: true,
      });
      return data;
    },
    enabled: mode === "your-own" || platformGate === "gated",
    staleTime: 60_000,
    retry: shouldRetryDaemonError,
    meta: { errorContext: "byo_email_credential_check" },
  });

  useEffect(() => {
    if (!byoCredentialQuery.error) {
      return;
    }
    captureError(byoCredentialQuery.error, {
      context: "byo_email_credential_check",
      bestEffort: true,
    });
  }, [byoCredentialQuery.error]);

  const byoConfigured = byoCredentialQuery.data?.hasSecret === true;

  // -- Handlers --------------------------------------------------------------
  const handleModeChange = useCallback((next: ServiceMode) => {
    setMode(next);
    setLocalSetting(LS_EMAIL_MODE, next);
  }, []);

  const handleSaveMode = useCallback(() => {
    setLocalSetting(LS_EMAIL_BYO_PROVIDER, byoProviderId);
    toast.success(t("emailChannelSection.saveSuccessToast"));
  }, [byoProviderId, t]);

  // -- Render ----------------------------------------------------------------
  const selectedByoProvider = useMemo(
    () =>
      EMAIL_BYO_PROVIDERS.find((p) => p.id === byoProviderId) ??
      EMAIL_BYO_PROVIDERS[0]!,
    [byoProviderId],
  );

  const byoSetupInstructions = (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 text-body-small-default text-[var(--content-tertiary)]">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--system-positive-strong)]" />
      <div className="flex flex-col gap-1">
        <span>
          <Trans
            i18nKey="emailChannelSection.setupInstructions"
            ns="channels"
            values={{
              providerName: selectedByoProvider.displayName,
              setupSkill: selectedByoProvider.setupSkill,
            }}
            components={{
              code: (
                <code className="rounded bg-[var(--surface-active)] px-1 py-0.5 text-[12px]" />
              ),
            }}
          />
        </span>
        <a
          href={selectedByoProvider.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[var(--system-positive-strong)] underline hover:opacity-80"
        >
          {t("emailChannelSection.openProvider", {
            providerName: selectedByoProvider.displayName,
          })}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );

  const yourOwnContent = (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          {t("emailChannelSection.providerLabel")}
        </label>
        <Select
          value={byoProviderId}
          onChange={(val) => {
            if (val === "mailgun" || val === "resend") {
              setByoProviderId(val);
            }
          }}
          options={EMAIL_BYO_PROVIDERS.map((p) => ({
            value: p.id,
            label: p.displayName,
          }))}
        />
      </div>

      {byoConfigured ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg border border-[var(--system-positive-subtle)] bg-[var(--surface-sunken)] p-3 text-body-small-default text-[var(--content-default)]">
            <CircleCheck className="h-4 w-4 shrink-0 text-[var(--system-positive-strong)]" />
            <span>
              <Trans
                i18nKey="emailChannelSection.apiKeyConfigured"
                ns="channels"
                values={{
                  providerName: selectedByoProvider.displayName,
                  setupSkill: selectedByoProvider.setupSkill,
                }}
                components={{
                  code: (
                    <code className="rounded bg-[var(--surface-active)] px-1 py-0.5 text-[12px]" />
                  ),
                }}
              />
            </span>
          </div>
          <a
            href={selectedByoProvider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-body-small-default text-[var(--system-positive-strong)] underline hover:opacity-80"
          >
            {t("emailChannelSection.openProvider", {
              providerName: selectedByoProvider.displayName,
            })}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : (
        byoSetupInstructions
      )}

      <div className="flex items-center gap-2">
        <SaveButton onClick={handleSaveMode} disabled={false} />
      </div>
    </div>
  );

  if (platformGate === "gated") {
    return (
      <ByoServiceCard
        id="email"
        title={t("emailChannelSection.title")}
        subtitle={t("emailChannelSection.subtitle")}
      >
        {yourOwnContent}
      </ByoServiceCard>
    );
  }

  return (
    <ServiceCard
      id="email"
      title={t("emailChannelSection.title")}
      subtitle={t("emailChannelSection.subtitle")}
      mode={mode}
      onModeChange={handleModeChange}
    >
      {mode === "managed" ? (
        <div className="space-y-4">
          {platformGate === "disabled" ? (
            <PlatformLoginNotice>
              {t("emailChannelSection.platformLoginNotice")}
            </PlatformLoginNotice>
          ) : managedAssistantId === null ? (
            <div className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("emailChannelSection.connecting")}
            </div>
          ) : (
            <EmailManagedContent
              assistantId={managedAssistantId}
              assistantHandle={assistantHandle}
              emailRootDomain={emailRootDomain}
            />
          )}
        </div>
      ) : (
        yourOwnContent
      )}
    </ServiceCard>
  );
}
