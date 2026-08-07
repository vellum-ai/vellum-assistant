/**
 * The Channels rail's selection, held in the URL.
 *
 * `/assistant/channels/telegram` names the row on screen, so a selection can
 * be linked, bookmarked and reloaded onto.
 *
 * Navigation replaces rather than pushes: moving between rows of one settings
 * page is not a step someone wants to walk back through, and pushing would
 * make Back retrace every row visited before leaving the page.
 */

import { useCallback } from "react";
import { useNavigate, useParams } from "react-router";

export interface ChannelRouteSelection {
  /** The channel named in the URL, or undefined at `/assistant/channels`. */
  selected: string | undefined;
  select: (channelId: string) => void;
}

export function useChannelRouteSelection(): ChannelRouteSelection {
  const { channelId } = useParams<{ channelId: string }>();
  const navigate = useNavigate();

  const select = useCallback(
    (next: string) => {
      navigate(`/assistant/channels/${encodeURIComponent(next)}`, {
        replace: true,
      });
    },
    [navigate],
  );

  return { selected: channelId, select };
}
