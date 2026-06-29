import { X } from "lucide-react";
import { useCallback } from "react";

import { Button } from "@vellumai/design-library";

import { SlackSetupWizard } from "@/components/slack-setup-wizard";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { integrationsSlackChannelConfigPost } from "@/generated/daemon/sdk.gen";
import type { ChannelSetupPayload } from "@/stores/viewer-store";

interface ChannelSetupPanelProps {
  payload: ChannelSetupPayload;
  onClose: () => void;
}

export function ChannelSetupPanel({ payload, onClose }: ChannelSetupPanelProps) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  const handleSave = useCallback(
    async (botToken: string, appToken: string) => {
      if (!assistantId) return;
      await integrationsSlackChannelConfigPost({
        path: { assistant_id: assistantId },
        body: { botToken, appToken },
        throwOnError: true,
      });
      onClose();
    },
    [assistantId, onClose],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
        <span className="text-title-small text-[var(--content-strong)]">
          Slack Setup
        </span>
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close setup panel"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {payload.channel === "slack" && (
          <SlackSetupWizard
            assistantName={payload.assistantName}
            onSave={handleSave}
          />
        )}
      </div>
    </div>
  );
}
