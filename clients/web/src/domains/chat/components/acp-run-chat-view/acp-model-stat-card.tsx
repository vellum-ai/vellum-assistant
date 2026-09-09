/**
 * MODEL tile in the ACP run detail panel.
 *
 * Read only: it names the model the adapter reports for the session, which
 * reaches the store through `acp_session_model_update` and the `/acp/sessions`
 * snapshot. The model a session runs on is chosen in conversation with the
 * assistant, so there is nothing to pick here.
 */

import { Sparkles } from "lucide-react";

import { MetricCard } from "@/domains/chat/components/metric-card";
import { useTranslation } from "@/i18n";

export function AcpModelStatCard({ model }: { model: string }) {
  const { t } = useTranslation("chat");
  return (
    <MetricCard
      icon={
        <Sparkles
          className="h-4 w-4 shrink-0"
          style={{ color: "var(--content-secondary)" }}
        />
      }
      value={model}
      label={t("acpRunChatView.modelLabel")}
    />
  );
}
