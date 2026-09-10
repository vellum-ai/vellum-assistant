/**
 * MODEL tile in the ACP run detail panel.
 *
 * Read only: it names the model the adapter reports for the session, which
 * reaches the store through `acp_session_model_update` and the `/acp/sessions`
 * snapshot. The model a session runs on is chosen in conversation with the
 * assistant, so there is nothing to pick here.
 */

import { Sparkles } from "lucide-react";

import type { AcpModelOption } from "@/domains/chat/acp-run-store";
import { MetricCard } from "@/domains/chat/components/metric-card";
import { useTranslation } from "@/i18n";

export function AcpModelStatCard({
  model,
  options,
}: {
  model: string;
  options?: AcpModelOption[];
}) {
  const { t } = useTranslation("chat");
  // The adapter names its own models, so an alias it advertises reads as
  // "Best available" rather than the `best` it is keyed by. An adapter that
  // advertises no list, or a model absent from one, keeps the wire value.
  const named = options?.find((option) => option.value === model)?.label;
  const value = named ?? model;
  return (
    <MetricCard
      icon={
        <Sparkles
          className="h-4 w-4 shrink-0"
          style={{ color: "var(--content-secondary)" }}
        />
      }
      value={value}
      // A model id is longer than the tile, so the row ellipses it.
      valueTitle={value}
      label={t("acpRunChatView.modelLabel")}
    />
  );
}
