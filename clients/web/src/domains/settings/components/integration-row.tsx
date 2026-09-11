import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Pencil, XCircle } from "lucide-react";
import { useState } from "react";

import {
  assistantsOauthConnectionsListQueryKey,
  assistantsOauthConnectionsListSetQueryData,
  useAssistantsOauthDisconnectByConnectionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { useTranslation } from "@/i18n";
import { ActionMenu } from "@vellumai/design-library/components/action-menu";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import type { PlatformGateState } from "@/hooks/use-platform-gate";

import { extractErrorMessage } from "@/utils/api-errors";

import { IntegrationListRow } from "./integration-list-row";

interface IntegrationRowProps {
  platformAssistantId: string;
  providerKey: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  connection: OAuthConnection | null;
  platformGate: PlatformGateState;
  onConfigure: () => void;
}

export function IntegrationRow({
  platformAssistantId,
  providerKey,
  displayName,
  description,
  logoUrl,
  connection,
  platformGate,
  onConfigure,
}: IntegrationRowProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const isConnected = Boolean(connection?.connected);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDisableOpen, setConfirmDisableOpen] = useState(false);

  const connectionsQueryKey = assistantsOauthConnectionsListQueryKey({
    path: { assistant_id: platformAssistantId },
  });

  const connectionsOpts = { path: { assistant_id: platformAssistantId } };

  const disconnectOAuth =
    useAssistantsOauthDisconnectByConnectionCreateMutation({
      onSuccess(_data, variables) {
        toast.success(
          t("integrationRow.disconnectedToast", { name: displayName }),
        );
        const connectionId = variables.path.connection_id;
        assistantsOauthConnectionsListSetQueryData(
          queryClient,
          connectionsOpts,
          (old) => old?.filter((c) => c.id !== connectionId),
        );
        queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
      },
      onError(error) {
        const detail = extractErrorMessage(
          error,
          undefined,
          t("integrationRow.disconnectFailedToast", { name: displayName }),
        );
        toast.error(detail);
      },
    });

  const handleDisable = () => {
    if (!connection?.id) {
      return;
    }
    setConfirmDisableOpen(true);
  };

  const confirmDisable = () => {
    setConfirmDisableOpen(false);
    if (!connection?.id) {
      return;
    }
    disconnectOAuth.mutate({
      path: { assistant_id: platformAssistantId, connection_id: connection.id },
    });
  };

  return (
    <>
      <IntegrationListRow
        icon={
          <IntegrationIcon
            providerKey={providerKey}
            displayName={displayName}
            logoUrl={logoUrl}
            size={32}
          />
        }
        title={displayName}
        subtitle={description}
        primaryAction={
          isConnected && platformGate === "full" ? (
            <IntegrationConfigureMenu
              displayName={displayName}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              onEditConnections={onConfigure}
              onDisable={handleDisable}
              disablePending={disconnectOAuth.isPending}
            />
          ) : (
            <Button variant="primary" onClick={onConfigure}>
              {t("integrationRow.connect")}
            </Button>
          )
        }
      />
      <ConfirmDialog
        open={confirmDisableOpen}
        title={t("integrationRow.disconnectTitle", { name: displayName })}
        message={t("integrationRow.disconnectMessage", { name: displayName })}
        confirmLabel={t("integrationRow.disconnect")}
        destructive
        onConfirm={confirmDisable}
        onCancel={() => setConfirmDisableOpen(false)}
      />
    </>
  );
}

export interface IntegrationConfigureMenuProps {
  displayName: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onEditConnections: () => void;
  onDisable: () => void;
  disablePending: boolean;
}

export function IntegrationConfigureMenu({
  displayName,
  open,
  onOpenChange,
  onEditConnections,
  onDisable,
  disablePending,
}: IntegrationConfigureMenuProps) {
  const { t } = useTranslation("settings");
  return (
    <ActionMenu.Root open={open} onOpenChange={onOpenChange}>
      <ActionMenu.Trigger asChild>
        <Button variant="outlined" rightIcon={<ChevronDown />}>
          {t("integrationRow.configure")}
        </Button>
      </ActionMenu.Trigger>
      <ActionMenu.Content
        title={displayName}
        showTitle
        closeLabel={t("integrationRow.actionsSheetClose")}
        align="end"
      >
        <ActionMenu.Item
          icon={Pencil}
          label={t("integrationRow.editConnections")}
          onSelect={onEditConnections}
        />
        <ActionMenu.Item
          icon={disablePending ? Loader2 : XCircle}
          label={t("integrationRow.disconnect")}
          tone="destructive"
          onSelect={onDisable}
          disabled={disablePending}
        />
      </ActionMenu.Content>
    </ActionMenu.Root>
  );
}
