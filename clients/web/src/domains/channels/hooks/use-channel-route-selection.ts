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
import { useLocation, useNavigate, useParams } from "react-router";

export interface ChannelRouteSelection {
  /** The channel named in the URL, or undefined at `/assistant/channels`. */
  selected: string | undefined;
  select: (channelId: string) => void;
}

export function useChannelRouteSelection(): ChannelRouteSelection {
  const { channelId } = useParams<{ channelId: string }>();
  const navigate = useNavigate();
  const { search } = useLocation();

  const select = useCallback(
    (next: string) => {
      // Selection owns only the path. The query string rides along untouched:
      // deep-link params like `release=1` arrive together with `setup=<id>`,
      // and the arrival effects (select here, param cleanup in
      // `useSetupChannelParam`) run in child-then-parent order, so a select
      // that rebuilt the URL from the path alone would drop the other
      // params' intent whenever it navigated last.
      navigate(
        { pathname: `/assistant/channels/${encodeURIComponent(next)}`, search },
        { replace: true },
      );
    },
    [navigate, search],
  );

  return { selected: channelId, select };
}
