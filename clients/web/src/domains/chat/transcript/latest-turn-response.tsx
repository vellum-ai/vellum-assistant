import { Fragment, memo } from "react";

import type { ResponseArtifact } from "@/domains/chat/transcript/response-artifacts";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import type { LatestTurnRowProps } from "@/domains/chat/transcript/latest-turn-row";

export interface LatestTurnResponseProps
  extends Omit<LatestTurnRowProps, "anchorMessage" | "responseItems"> {
  responseItems: TranscriptItem[];
  isStreaming: boolean;
  responseArtifactsByKey?: ReadonlyMap<string, ResponseArtifact[]>;
}

/** Shared renderer for the response rows after the latest user anchor. */
export const LatestTurnResponse = memo(function LatestTurnResponse({
  responseItems,
  isStreaming,
  responseArtifactsByKey,
  ...rowProps
}: LatestTurnResponseProps) {
  const lastMessageItem = responseItems.findLast(
    (item) => item.kind === "message",
  );
  return responseItems.map((response) => (
    <Fragment key={response.key}>
      <TranscriptRow
        item={response}
        {...rowProps}
        responseArtifacts={responseArtifactsByKey?.get(response.key)}
        isStreaming={isStreaming}
        isLatestMessage={response === lastMessageItem}
      />
    </Fragment>
  ));
});
