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
 * A bulk command names no single item's state, and reusing a state glyph for
 * it puts two envelopes with opposite meanings a row apart in the same menu.
 * It gets the check-marked envelope instead, which reads as a command in the
 * same family.
 */

import { Mail, MailCheck, MailOpen, type LucideIcon } from "lucide-react";

/** An item nobody has read yet: still sealed. */
export const UNREAD_ICON: LucideIcon = Mail;

/** An item that has been read: opened. */
export const READ_ICON: LucideIcon = MailOpen;

/** A command that reads everything at once, rather than a state. */
export const MARK_ALL_READ_ICON: LucideIcon = MailCheck;

/** The glyph naming the state an item is currently in. */
export function readStateIcon(isUnread: boolean): LucideIcon {
  return isUnread ? UNREAD_ICON : READ_ICON;
}
