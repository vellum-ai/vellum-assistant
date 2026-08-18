/**
 * Read-state iconography: the single source of truth for the glyph any
 * read/unread control shows, across notifications and conversations.
 *
 * One envelope pair carries the meaning everywhere. The glyph names the
 * state an item is in, never the command the control runs: a sealed
 * envelope for unread, an opened one for read. That keeps it agreeing with
 * the unread dot beside it on the same row, where a glyph naming the command
 * would put an opened envelope on every item the rest of the row calls
 * unread. The control's label ("Mark as read") names what it does.
 *
 * A bulk command has no single item state to name, so it takes the glyph of
 * the state it leaves everything in: `READ_ICON` for "Mark all as read".
 */

import { Mail, MailOpen, type LucideIcon } from "lucide-react";

/** An item nobody has read yet: still sealed. */
export const UNREAD_ICON: LucideIcon = Mail;

/** An item that has been read: opened. */
export const READ_ICON: LucideIcon = MailOpen;

/** The glyph naming the state an item is currently in. */
export function readStateIcon(isUnread: boolean): LucideIcon {
  return isUnread ? UNREAD_ICON : READ_ICON;
}
