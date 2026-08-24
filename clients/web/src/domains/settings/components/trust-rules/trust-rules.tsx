import { ShieldCheck } from "lucide-react";
import { useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { TrustRulesModal } from "@/domains/settings/components/trust-rules/trust-rules-modal";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";

export function TrustRules() {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <Card>
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--content-secondary)]" />
        <div className="flex-1">
          <h2 className="text-title-medium text-[var(--content-default)]">
            {t("trustRules.title")}
          </h2>
          <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("trustRules.description")}
          </p>
        </div>
        <Button variant="outlined" onClick={() => setModalOpen(true)}>
          {t("trustRules.manage")}
        </Button>
      </div>
      {modalOpen && (
        <TrustRulesModal
          assistantId={assistantId}
          onClose={() => setModalOpen(false)}
        />
      )}
    </Card>
  );
}
