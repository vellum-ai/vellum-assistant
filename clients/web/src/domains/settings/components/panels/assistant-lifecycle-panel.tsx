import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { hatchAssistant, listAssistants } from "@/assistant/api";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
import {
  isLocalClient,
  syncPlatformAssistantsToLockfile,
} from "@/lib/local-mode";
import {
  assistantsListOptions,
  assistantsRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type { Assistant } from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { useOrganizationStore } from "@/stores/organization-store";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

export function AssistantLifecyclePanel() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [hatching, setHatching] = useState(false);
  const [hatchConfirmOpen, setHatchConfirmOpen] = useState(false);
  const isOrgReady = useIsOrgReady();

  const activeAssistantId = useActiveAssistantId();

  const { data: assistant, isLoading: assistantLoading } = useQuery({
    ...assistantsRetrieveOptions({ path: { id: activeAssistantId } }),
    enabled: isOrgReady,
  });

  const { data: assistantsList, isLoading: listLoading } = useQuery({
    ...assistantsListOptions({ query: { hosting: "all" } }),
    enabled: isOrgReady,
  });

  const loading = assistantLoading || listLoading;
  const allAssistants = assistantsList?.results ?? [];

  const handleHatch = async () => {
    setHatchConfirmOpen(false);
    setHatching(true);
    try {
      // `create` mode so this actually provisions an *additional* assistant.
      // Without it the platform defaults to `ensure` and hands back the
      // existing assistant — the button then looked like a no-op.
      const result = await hatchAssistant(undefined, "create");
      if (result.ok) {
        // Mirror the freshly hatched assistant into the lockfile so the macOS
        // tray and CLI pick it up immediately. Unlike onboarding / the tray
        // "New Assistant" flow, this developer button is otherwise the one
        // managed-assistant creation path that never reconciled the lockfile —
        // newly hatched assistants stayed invisible to the tray until the next
        // session refresh. Best-effort and local-mode only; the hatch already
        // succeeded regardless of the sync outcome.
        if (isLocalClient()) {
          try {
            const list = await listAssistants();
            if (list.ok) {
              await syncPlatformAssistantsToLockfile(
                list.data,
                useOrganizationStore.getState().currentOrganizationId ??
                  undefined,
              );
            }
          } catch {
            // Sync failed — the assistant was still created.
          }
        }
        // 201 = newly created; 200 = server returned the existing assistant
        // (multi-assistant hatching disabled / deduped). Report honestly
        // instead of always claiming a new one was made.
        toast.success(
          result.status === 201
            ? t("assistantLifecyclePanel.hatchSuccessToast")
            : t("assistantLifecyclePanel.hatchExistingToast"),
        );
        // Invalidate the panel's own queries by their real generated keys so
        // the info + list cards refresh (the previous `["assistants"]` key
        // matched none of them).
        void queryClient.invalidateQueries({
          queryKey: [{ _id: "assistantsRetrieve" }],
        });
        void queryClient.invalidateQueries({
          queryKey: assistantsListOptions({ query: { hosting: "all" } })
            .queryKey,
        });
      } else {
        const detail =
          typeof result.error?.detail === "string"
            ? result.error.detail
            : t("assistantLifecyclePanel.hatchFailedToast");
        toast.error(detail);
      }
    } catch {
      toast.error(t("assistantLifecyclePanel.hatchFailedToast"));
    } finally {
      setHatching(false);
    }
  };

  return (
    <div className="space-y-6">
      <AssistantInfoCard assistant={assistant ?? null} loading={loading} />

      <AssistantListCard
        assistants={allAssistants}
        activeAssistantId={activeAssistantId}
        loading={loading}
      />

      <DetailCard
        title={t("assistantLifecyclePanel.hatchTitle")}
        subtitle={t("assistantLifecyclePanel.hatchSubtitle")}
      >
        <div className="flex items-center justify-between gap-4">
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("assistantLifecyclePanel.hatchDescription")}
          </p>
          <Button
            variant="outlined"
            leftIcon={
              hatching ? <Loader2 className="animate-spin" /> : undefined
            }
            onClick={() => setHatchConfirmOpen(true)}
            disabled={hatching}
            className="shrink-0"
          >
            {t("assistantLifecyclePanel.hatch")}
          </Button>
        </div>
        <ConfirmDialog
          open={hatchConfirmOpen}
          title={t("assistantLifecyclePanel.hatchConfirmTitle")}
          message={t("assistantLifecyclePanel.hatchConfirmMessage")}
          confirmLabel={t("assistantLifecyclePanel.hatch")}
          onConfirm={handleHatch}
          onCancel={() => setHatchConfirmOpen(false)}
        />
      </DetailCard>
    </div>
  );
}

interface AssistantInfoCardProps {
  assistant: Assistant | null;
  loading: boolean;
}

function AssistantInfoCard({ assistant, loading }: AssistantInfoCardProps) {
  const { t } = useTranslation("settings");

  if (loading) {
    return (
      <DetailCard title={t("assistantLifecyclePanel.infoTitle")}>
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("assistantLifecyclePanel.infoLoading")}
        </div>
      </DetailCard>
    );
  }

  if (!assistant) {
    return (
      <DetailCard title={t("assistantLifecyclePanel.infoTitle")}>
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("assistantLifecyclePanel.infoEmpty")}
        </p>
      </DetailCard>
    );
  }

  return (
    <DetailCard
      title={t("assistantLifecyclePanel.infoTitle")}
      subtitle={t("assistantLifecyclePanel.infoSubtitle")}
    >
      <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-3">
        <InfoLabel>{t("assistantLifecyclePanel.name")}</InfoLabel>
        <InfoValue>
          {assistant.name ?? t("assistantLifecyclePanel.unnamed")}
        </InfoValue>

        <InfoLabel>{t("assistantLifecyclePanel.status")}</InfoLabel>
        <div>
          <Tag tone={assistant.status === "active" ? "positive" : "neutral"}>
            {assistant.status}
          </Tag>
        </div>

        <InfoLabel>{t("assistantLifecyclePanel.assistantId")}</InfoLabel>
        <span className="break-all font-mono text-body-small-default text-[var(--content-tertiary)]">
          {assistant.id}
        </span>

        {assistant.machine_id && (
          <>
            <InfoLabel>{t("assistantLifecyclePanel.machineId")}</InfoLabel>
            <span className="break-all font-mono text-body-small-default text-[var(--content-tertiary)]">
              {assistant.machine_id}
            </span>
          </>
        )}

        <InfoLabel>{t("assistantLifecyclePanel.created")}</InfoLabel>
        <InfoValue>
          {new Date(assistant.created).toLocaleDateString()}
        </InfoValue>

        <InfoLabel>{t("assistantLifecyclePanel.lastModified")}</InfoLabel>
        <InfoValue>
          {new Date(assistant.modified).toLocaleDateString()}
        </InfoValue>

        {assistant.current_release_version && (
          <>
            <InfoLabel>{t("assistantLifecyclePanel.version")}</InfoLabel>
            <InfoValue>{assistant.current_release_version}</InfoValue>
          </>
        )}
      </div>
    </DetailCard>
  );
}

interface AssistantListCardProps {
  assistants: Assistant[];
  activeAssistantId: string;
  loading: boolean;
}

function AssistantListCard({
  assistants,
  activeAssistantId,
  loading,
}: AssistantListCardProps) {
  const { t } = useTranslation("settings");

  if (loading || assistants.length === 0) {
    return null;
  }

  return (
    <DetailCard
      title={t("assistantLifecyclePanel.allAssistantsTitle")}
      subtitle={t("assistantLifecyclePanel.allAssistantsSubtitle", {
        count: assistants.length,
      })}
    >
      <div className="max-h-[300px] space-y-2 overflow-y-auto">
        {assistants.map((a) => {
          const isActive = a.id === activeAssistantId;
          return (
            <div
              key={a.id}
              className={`flex items-center justify-between gap-4 rounded-lg border px-4 py-3 ${
                isActive
                  ? "border-[var(--border-focus)] bg-[var(--surface-lift)]"
                  : "border-[var(--border-base)] bg-[var(--surface-default)]"
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-body-medium-default text-[var(--content-default)]">
                    {a.name || t("assistantLifecyclePanel.unnamed")}
                  </span>
                  <Tag tone={a.status === "active" ? "positive" : "neutral"}>
                    {a.status}
                  </Tag>
                  {isActive && (
                    <Tag tone="warning">
                      {t("assistantLifecyclePanel.current")}
                    </Tag>
                  )}
                </div>
                <span className="font-mono text-body-small-default text-[var(--content-tertiary)]">
                  {a.id}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </DetailCard>
  );
}

function InfoLabel({ children }: { children: string }) {
  return (
    <span className="text-body-medium-default text-[var(--content-tertiary)]">
      {children}
    </span>
  );
}

function InfoValue({ children }: { children: string | undefined }) {
  return (
    <span className="text-body-medium-lighter text-[var(--content-default)]">
      {children}
    </span>
  );
}
