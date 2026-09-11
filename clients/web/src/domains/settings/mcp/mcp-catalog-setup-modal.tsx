import { useState } from "react";
import { Button } from "@vellumai/design-library/components/button";
import { Checkbox } from "@vellumai/design-library/components/checkbox";
import { Modal } from "@vellumai/design-library/components/modal";

import { useTranslation } from "@/i18n";
import { openUrlInNewTab } from "@/runtime/browser";

import type { McpCatalogEntry } from "./mcp-catalog-api";

export function McpCatalogSetupModal({
  entry,
  onClose,
  onConnect,
}: {
  entry: McpCatalogEntry;
  onClose: () => void;
  onConnect: (acknowledged: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const [acknowledged, setAcknowledged] = useState(false);
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
            <Checkbox
              checked={acknowledged}
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
            disabled={manual && !acknowledged}
            onClick={() => onConnect(acknowledged)}
          >
            {t("integrationRow.connect")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
