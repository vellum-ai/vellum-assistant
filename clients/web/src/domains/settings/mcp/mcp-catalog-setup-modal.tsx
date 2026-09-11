import { useState } from "react";
import { Button } from "@vellumai/design-library/components/button";
import { Checkbox } from "@vellumai/design-library/components/checkbox";
import { Modal } from "@vellumai/design-library/components/modal";

import { useWebhooksRegisterPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { openUrlInNewTab } from "@/runtime/browser";

import type { McpCatalogEntry } from "./mcp-catalog-api";

export function McpCatalogSetupModal({
  assistantId,
  entry,
  onClose,
  onConnect,
}: {
  assistantId: string;
  entry: McpCatalogEntry;
  onClose: () => void;
  onConnect: (acknowledged: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const [acknowledged, setAcknowledged] = useState(false);
  const callback = useWebhooksRegisterPostMutation({
    onError: (error) =>
      captureError(error, { context: "mcp.catalog.callback" }),
  });
  const callbackUrl = callback.data?.callbackUrl;
  const { copy, copied } = useCopyToClipboard({
    errorMessage: t("mcpCatalog.callbackCopyFailed"),
  });
  const manual = entry.setup.mode === "manual";
  return (
    <Modal.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Modal.Content>
        <Modal.Header>
          <Modal.Title className="[&>span]:whitespace-normal">
            {t("mcpCatalog.setupTitle", { name: entry.displayName })}
          </Modal.Title>
          <Modal.Description>{entry.description}</Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          <p className="text-body-medium-default [overflow-wrap:anywhere]">
            {entry.setup.instructions ?? t("mcpCatalog.manualInstructions")}
          </p>
          <Button
            variant="outlined"
            className="min-h-11"
            onClick={() => void openUrlInNewTab(entry.documentationUrl)}
          >
            {t("mcpCatalog.openDocumentation")}
          </Button>
          {manual ? (
            <div className="space-y-2">
              {callbackUrl ? (
                <>
                  <p>{t("mcpCatalog.callbackUrlLabel")}</p>
                  <p className="select-text rounded-md bg-[var(--surface-lift)] p-3 font-mono text-sm [overflow-wrap:anywhere]">
                    {callbackUrl}
                  </p>
                  <Button
                    variant="outlined"
                    className="min-h-11 max-w-full whitespace-normal"
                    onClick={() => copy(callbackUrl)}
                  >
                    {t(
                      copied
                        ? "mcpCatalog.callbackCopied"
                        : "mcpCatalog.copyCallbackUrl",
                    )}
                  </Button>
                </>
              ) : (
                <Button
                  variant="outlined"
                  className="min-h-11 max-w-full whitespace-normal"
                  disabled={callback.isPending}
                  onClick={() =>
                    callback.mutate({
                      path: { assistant_id: assistantId },
                      body: { type: "oauth", path: "webhooks/oauth/callback" },
                    })
                  }
                >
                  {t("mcpCatalog.loadCallbackUrl")}
                </Button>
              )}
              {callback.isError ? (
                <p role="alert">{t("mcpCatalog.callbackUrlFailed")}</p>
              ) : null}
            </div>
          ) : null}
          {manual ? (
            <Checkbox
              checked={acknowledged}
              disabled={!callbackUrl}
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
              label={t("mcpCatalog.setupAcknowledged")}
              className="min-h-11"
            />
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            {t("mcpServerDetailModal.cancel")}
          </Button>
          <Button
            className="min-h-11"
            disabled={manual && (!callbackUrl || !acknowledged)}
            onClick={() => onConnect(acknowledged)}
          >
            {t("integrationRow.connect")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
