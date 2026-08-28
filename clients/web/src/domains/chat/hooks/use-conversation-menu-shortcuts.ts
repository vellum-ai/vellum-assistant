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
 *
 * All three commands act on the active conversation rather than on whichever
 * row's menu is open, so a menu that is not the active conversation's gets no
 * hints: drawing one there would name a key that acts on a different
 * conversation than the menu names. `targetsActiveConversation` is the
 * caller's assertion that the two are the same, and it defaults to nothing
 * being advertised.
 */
export function useConversationMenuShortcuts(
  targetsActiveConversation: boolean,
): ConversationMenuShortcuts {
  const pin = useCommandShortcut("togglePinConversation");
  const markUnread = useCommandShortcut("markCurrentUnread");
  const openInNewWindow = useCommandShortcut("popOut");

  return useMemo(
    () =>
      targetsActiveConversation ? { pin, markUnread, openInNewWindow } : {},
    [targetsActiveConversation, pin, markUnread, openInNewWindow],
  );
}
