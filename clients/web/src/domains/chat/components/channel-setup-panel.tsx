import { useQuery } from "@tanstack/react-query";
import { CheckCircle } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@vellumai/design-library";

import { SlackSetupWizard } from "@/components/slack-setup-wizard";
import { DetailShell } from "@/domains/chat/components/detail-shell";
import { channelsReadinessGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useSaveSlackConfig } from "@/hooks/use-save-slack-config";
import type { ChannelSetupPayload } from "@/stores/viewer-store";
import { publicAsset } from "@/utils/public-asset";

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

  const slackIcon = (
    <img
      src={publicAsset("/images/integrations/slack.svg")}
      alt=""
      className="size-5 shrink-0"
    />
  );

  return (
    <DetailShell
      icon={slackIcon}
      title={isConnected ? "Slack settings" : "Slack setup"}
      closeLabel="Close setup panel"
      onClose={onClose}
    >
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
          compact
          onSave={(bot, app) => saveSlack.mutate({ botToken: bot, appToken: app })}
          saveStatus={saveSlack.status}
          saveError={saveSlack.error?.message ?? null}
        />
      ) : null}
    </DetailShell>
  );
}
