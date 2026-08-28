import { useMemo } from "react";

import { useCommandShortcut } from "@/hooks/use-command-shortcut";

/**
 * Accelerators for the conversation menu actions that have a keyboard
 * shortcut, keyed by the item rather than by the command so the menu builders
 * read as the rows they draw.
 *
 * A command with no binding on this host is absent, which is the common case
 * in a browser: all three of these are desktop menu commands.
 */
export interface ConversationMenuShortcuts {
  pin?: string;
  markUnread?: string;
  openInNewWindow?: string;
}

/**
 * The bindings behind the conversation menu, resolved for the current host.
 *
 * The menu builders are plain functions and cannot hold a hook, so their
 * callers own the reactive binding and thread the result in, the same way they
 * already do for `t`.
 */
export function useConversationMenuShortcuts(): ConversationMenuShortcuts {
  const pin = useCommandShortcut("togglePinConversation");
  const markUnread = useCommandShortcut("markCurrentUnread");
  const openInNewWindow = useCommandShortcut("popOut");

  return useMemo(
    () => ({ pin, markUnread, openInNewWindow }),
    [pin, markUnread, openInNewWindow],
  );
}
