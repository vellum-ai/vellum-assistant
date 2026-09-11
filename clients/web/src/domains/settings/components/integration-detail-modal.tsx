import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  assistantsOauthConnectionsListOptions,
  assistantsOauthConnectionsListQueryKey,
  assistantsOauthConnectionsListSetQueryData,
  useAssistantsOauthDisconnectByConnectionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Modal } from "@vellumai/design-library/components/modal";
import {
  SegmentControl,
  type SegmentControlItem,
} from "@vellumai/design-library/components/segment-control";
import { toast } from "@vellumai/design-library/components/toast";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { useManagedOAuthConnect } from "@/hooks/use-managed-oauth-connect";
import type { PlatformGateState } from "@/hooks/use-platform-gate";
import { useActiveAssistantIsPlatformHosted } from "@/hooks/use-platform-gate";
import { extractErrorMessage } from "@/utils/api-errors";

import { ManagedTab } from "@/domains/settings/components/managed-oauth-tab";
import { YourOwnTab } from "@/domains/settings/components/your-own-oauth-tab";
import { getConnectPresets } from "@/domains/settings/oauth-scope-presets";

type ModalTab = "managed" | "your-own";

interface IntegrationDetailModalProps {
  assistantId: string;
  platformAssistantId: string;
  providerKey: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  platformGate: PlatformGateState;
  onClose: () => void;
}

/**
 * Provider OAuth configuration modal with Managed / Your Own segmented tabs.
 * Managed tab handles Vellum-hosted OAuth connections via popup or native flow.
 * Your Own tab handles user-provided OAuth app credentials.
 */
export function IntegrationDetailModal({
  assistantId,
  platformAssistantId,
  providerKey,
  displayName,
  description,
  logoUrl,
  platformGate,
  onClose,
}: IntegrationDetailModalProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const managedAvailable = platformGate === "full";
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const yourOwnAvailable = !isPlatformHosted;
  const [activeTab, setActiveTab] = useState<ModalTab>(
    platformGate === "gated" && yourOwnAvailable ? "your-own" : "managed",
  );

  const modeSegments: SegmentControlItem<ModalTab>[] = useMemo(
    () => [
      { value: "managed", label: t("integrationDetailModal.managedTab") },
      { value: "your-own", label: t("integrationDetailModal.yourOwnTab") },
    ],
    [t],
  );

  useEffect(() => {
    if (!yourOwnAvailable && activeTab === "your-own") {
      setActiveTab("managed");
    }
  }, [yourOwnAvailable, activeTab]);

  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(
    null,
  );
  const [connectionPendingDisconnect, setConnectionPendingDisconnect] =
    useState<OAuthConnection | null>(null);

  const connectionsQueryKey = assistantsOauthConnectionsListQueryKey({
    path: { assistant_id: platformAssistantId },
  });

  const { data: allConnections, isLoading: connectionsLoading } = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: platformAssistantId },
    }),
    enabled: managedAvailable,
  });

  const providerConnections: OAuthConnection[] = (allConnections ?? []).filter(
    (c) => c.provider === providerKey,
  );

  const managedConnect = useManagedOAuthConnect({
    assistantId,
    providerKey,
    providerLabel: displayName,
  });
  const handleConnect = (requestedScopes?: string[]) => {
    if (!managedAvailable) {
      return;
    }
    managedConnect.connect(requestedScopes);
  };

  // The connections list this modal renders is the same query the connect
  // flow watches, so a new account arrives on its own and only the toast is
  // reported here.
  const connectStatus = managedConnect.status;
  useEffect(() => {
    if (connectStatus === "connected") {
      toast.success(
        t("useOauthConnect.accountConnected", {
          name: displayName,
          ns: "common",
        }),
      );
    }
  }, [connectStatus, displayName, t]);

  // Closing the modal abandons an authorization still in flight, so reopening
  // this provider offers Connect rather than a wait nothing will end.
  const dismissConnect = managedConnect.dismiss;
  useEffect(() => dismissConnect, [dismissConnect]);

  const connectError = managedConnect.errorMessage;
  useEffect(() => {
    if (connectError) {
      toast.error(connectError);
    }
  }, [connectError]);

  const connectionsOpts = { path: { assistant_id: platformAssistantId } };

  const disconnectOAuth =
    useAssistantsOauthDisconnectByConnectionCreateMutation({
      onSuccess(_data, variables) {
        toast.success(
          t("integrationDetailModal.disconnectedToast", { name: displayName }),
        );
        const connectionId = variables.path.connection_id;
        assistantsOauthConnectionsListSetQueryData(
          queryClient,
          connectionsOpts,
          (old) => old?.filter((c) => c.id !== connectionId),
        );
        queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
        setPendingDisconnectId(null);
      },
      onError(error) {
        const detail = extractErrorMessage(
          error,
          undefined,
          t("integrationDetailModal.disconnectFailedToast", {
            name: displayName,
          }),
        );
        toast.error(detail);
        setPendingDisconnectId(null);
      },
    });

  const handleDisconnect = (connection: OAuthConnection) => {
    setConnectionPendingDisconnect(connection);
  };

  const confirmDisconnect = () => {
    const connection = connectionPendingDisconnect;
    setConnectionPendingDisconnect(null);
    if (!connection) {
      return;
    }
    setPendingDisconnectId(connection.id);
    disconnectOAuth.mutate({
      path: { assistant_id: platformAssistantId, connection_id: connection.id },
    });
  };

  const accountLabel =
    connectionPendingDisconnect?.account_label ??
    t("integrationDetailModal.accountFallback", { name: displayName });

  const subtitle = description
    ? t("integrationDetailModal.subtitleWithDescription", {
        name: displayName,
        description,
      })
    : t("integrationDetailModal.subtitle", { name: displayName });

  return (
    <>
      <Modal.Root
        open
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
      >
        <Modal.Content
          hideCloseButton
          className="max-h-full"
          overlayClassName="pt-[max(1rem,var(--safe-area-inset-top,env(safe-area-inset-top,0px)))] pb-[max(1rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]"
        >
          <Modal.Header className="pr-14">
            <div className="flex min-w-0 items-center gap-3">
              <IntegrationIcon
                providerKey={providerKey}
                displayName={displayName}
                logoUrl={logoUrl}
                size={32}
              />
              <div className="min-w-0">
                <Modal.Title className="[overflow-wrap:anywhere] [&>span]:whitespace-normal">
                  {t("integrationDetailModal.title", { name: displayName })}
                </Modal.Title>
                <Modal.Description>{subtitle}</Modal.Description>
              </div>
            </div>
          </Modal.Header>
          <Modal.Close asChild>
            <Button
              variant="ghost"
              iconOnly={<X />}
              className="absolute right-2 top-2 min-h-11 min-w-11"
              aria-label={t("integrationDetailModal.close")}
            />
          </Modal.Close>
          <Modal.Body className="min-h-0 space-y-4">
            {platformGate !== "gated" && yourOwnAvailable && (
              <SegmentControl
                ariaLabel={t("integrationDetailModal.oauthModeAriaLabel")}
                items={modeSegments}
                value={activeTab}
                onChange={setActiveTab}
              />
            )}

            {activeTab === "managed" && platformGate !== "gated" ? (
              platformGate === "disabled" ? (
                <PlatformLoginNotice>
                  {t("integrationDetailModal.loginNotice")}
                </PlatformLoginNotice>
              ) : (
                <ManagedTab
                  displayName={displayName}
                  providerKey={providerKey}
                  logoUrl={logoUrl}
                  connections={providerConnections}
                  connectionsLoading={connectionsLoading}
                  oauthInProgress={managedConnect.status === "attempting"}
                  onCancelConnect={managedConnect.dismiss}
                  disconnectingId={
                    disconnectOAuth.isPending ? pendingDisconnectId : null
                  }
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                  connectPresets={getConnectPresets(providerKey)}
                />
              )
            ) : yourOwnAvailable ? (
              <YourOwnTab
                assistantId={assistantId}
                providerKey={providerKey}
                displayName={displayName}
                logoUrl={logoUrl}
              />
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outlined" className="min-h-11" onClick={onClose}>
              {t("integrationDetailModal.confirm")}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
      <ConfirmDialog
        open={connectionPendingDisconnect !== null}
        title={t("integrationDetailModal.disconnectTitle", {
          name: displayName,
        })}
        message={
          connectionPendingDisconnect
            ? t("integrationDetailModal.disconnectMessage", {
                account: accountLabel,
              })
            : ""
        }
        confirmLabel={t("integrationDetailModal.disconnect")}
        destructive
        onConfirm={confirmDisconnect}
        onCancel={() => setConnectionPendingDisconnect(null)}
      />
    </>
  );
}
