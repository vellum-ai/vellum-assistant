import {
    CircleCheck,
    ExternalLink,
    Info,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import {
    assistantsListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { credentialsInspectPost } from "@/generated/daemon/sdk.gen";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { useEnvironmentStore } from "@/stores/environment-store";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

import { ByoServiceCard, SaveButton, ServiceCard } from "@/domains/settings/ai/ai-shared-ui";
import type { EmailByoProvider, ServiceMode } from "@/domains/settings/ai/ai-types";
import {
    EMAIL_BYO_PROVIDERS,
    LS_EMAIL_BYO_PROVIDER,
    LS_EMAIL_MODE,
} from "@/domains/settings/ai/ai-types";
import { EmailManagedContent } from "@/domains/settings/ai/email-managed-content";

export function EmailServiceCard() {
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id;
  const assistantHandle = assistantList?.results?.[0]?.handle;

  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const platformGate = usePlatformGate();
  const activeAssistantId = useAssistantSelectionStore.use.activeAssistantId();

  // Use the platform assistant ID when available, falling back to the
  // lifecycle-backed selection store for self-hosted mode where the platform
  // assistant list may be empty.
  const byoAssistantId = assistantId ?? activeAssistantId;

  const [mode, setMode] = useState<ServiceMode>(
    () => platformGate === "gated" ? "your-own" : getLocalSetting(LS_EMAIL_MODE, "managed") as ServiceMode,
  );
  const [byoProviderId, setByoProviderId] = useState<EmailByoProvider["id"]>(
    () => getLocalSetting(LS_EMAIL_BYO_PROVIDER, "resend") as EmailByoProvider["id"],
  );

  // -- BYO credential check (your-own mode) ----------------------------------
  const byoCredentialQuery = useQuery({
    queryKey: ["byoEmailCredential", byoAssistantId, byoProviderId],
    queryFn: async () => {
      const { data } = await credentialsInspectPost({
        path: { assistant_id: byoAssistantId! },
        body: { service: byoProviderId, field: "api_key" },
        throwOnError: true,
      });
      return data;
    },
    enabled: !!byoAssistantId && (mode === "your-own" || platformGate === "gated"),
    staleTime: 60_000,
    retry: shouldRetryDaemonError,
    meta: { errorContext: "byo_email_credential_check" },
  });

  useEffect(() => {
    if (!byoCredentialQuery.error) return;
    captureError(byoCredentialQuery.error, { context: "byo_email_credential_check", bestEffort: true });
  }, [byoCredentialQuery.error]);

  const byoConfigured = byoCredentialQuery.data?.hasSecret === true;

  // -- Handlers --------------------------------------------------------------
  const handleModeChange = useCallback((next: ServiceMode) => {
    setMode(next);
    setLocalSetting(LS_EMAIL_MODE, next);
  }, []);

  const handleSaveMode = useCallback(() => {
    setLocalSetting(LS_EMAIL_BYO_PROVIDER, byoProviderId);
    toast.success("Email settings saved.");
  }, [byoProviderId]);

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
          Configure {selectedByoProvider.displayName} via the assistant
          CLI: ask the assistant to run the{" "}
          <code className="rounded bg-[var(--surface-active)] px-1 py-0.5 text-[12px]">
            {selectedByoProvider.setupSkill}
          </code>{" "}
          skill. It walks you through storing the API key, detecting the
          domain, and (optionally) wiring up an inbound webhook.
        </span>
        <a
          href={selectedByoProvider.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[var(--system-positive-strong)] underline hover:opacity-80"
        >
          Open {selectedByoProvider.displayName}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );

  const yourOwnContent = (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          Provider
        </label>
        <Dropdown
          value={byoProviderId}
          onChange={(val) =>
            setByoProviderId(val as EmailByoProvider["id"])
          }
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
              {selectedByoProvider.displayName} API key configured.
              To reconfigure, run the{" "}
              <code className="rounded bg-[var(--surface-active)] px-1 py-0.5 text-[12px]">
                {selectedByoProvider.setupSkill}
              </code>{" "}
              skill.
            </span>
          </div>
          <a
            href={selectedByoProvider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-body-small-default text-[var(--system-positive-strong)] underline hover:opacity-80"
          >
            Open {selectedByoProvider.displayName}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : byoSetupInstructions}

      <div className="flex items-center gap-2">
        <SaveButton onClick={handleSaveMode} disabled={false} />
      </div>
    </div>
  );

  if (platformGate === "gated") {
    return (
      <ByoServiceCard
        id="email"
        title="Email"
        subtitle="Configure how your assistant sends and receives email"
      >
        {yourOwnContent}
      </ByoServiceCard>
    );
  }

  return (
    <ServiceCard
      id="email"
      title="Email"
      subtitle="Configure how your assistant sends and receives email"
      mode={mode}
      onModeChange={handleModeChange}
    >
      {mode === "managed" ? (
        <div className="space-y-4">
          {platformGate === "disabled" ? (
            <Notice tone="info">
              Log in to the Vellum platform to manage email settings.
            </Notice>
          ) : !assistantId ? (
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              No assistant found yet.
            </p>
          ) : (
            <EmailManagedContent
              assistantId={assistantId}
              assistantHandle={assistantHandle}
              emailRootDomain={emailRootDomain}
            />
          )}
        </div>
      ) : yourOwnContent}
    </ServiceCard>
  );
}
