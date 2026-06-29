import { useQuery } from "@tanstack/react-query";
import { CheckCircle, X } from "lucide-react";
import { useCallback, useMemo } from "react";

import { Button } from "@vellumai/design-library";

import { SlackSetupWizard } from "@/components/slack-setup-wizard";
import { channelsReadinessGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useSaveSlackConfig } from "@/hooks/use-save-slack-config";
import type { ChannelSetupPayload } from "@/stores/viewer-store";

interface ChannelSetupPanelProps {
  payload: ChannelSetupPayload;
  onClose: () => void;
}

export function ChannelSetupPanel({ payload, onClose }: ChannelSetupPanelProps) {
  const saveSlack = useSaveSlackConfig({
    assistantId: payload.assistantId,
    onSuccess: onClose,
  });

  const readinessOpts = useMemo(
    () => ({ path: { assistant_id: payload.assistantId } }),
    [payload.assistantId],
  );
  const readinessQuery = useQuery({
    ...channelsReadinessGetOptions(readinessOpts),
    select: (data) =>
      data.snapshots?.some(
        (s) => s.channel === payload.channel && s.ready,
      ) ?? false,
  });
  const isConnected = readinessQuery.data === true;

  const handleSave = useCallback(
    async (botToken: string, appToken: string) => {
      await saveSlack.mutateAsync({ botToken, appToken });
    },
    [saveSlack],
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
        {isConnected ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle className="h-8 w-8 text-[var(--content-positive)]" />
            <span className="text-title-small text-[var(--content-strong)]">
              Slack is connected
            </span>
            <span className="text-body-small text-[var(--content-subtle)]">
              Your assistant is ready to receive messages on Slack.
            </span>
            <Button variant="outlined" size="compact" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : payload.channel === "slack" ? (
          <SlackSetupWizard
            assistantName={payload.assistantName}
            onSave={handleSave}
          />
        ) : null}
      </div>
    </div>
  );
}
