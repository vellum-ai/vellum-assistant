/**
 * The width the Chat Info panel opens its drawer at.
 *
 * Its own module so the chat layout can read the number without importing the
 * lazily-loaded panel, which would pull that chunk back into the main bundle.
 */

import { DETAIL_SHELL_BODY_INSET_PX } from "@/components/detail-shell";

/** The width the mock draws the rows at: four file tiles, or three app tiles. */
export const CHAT_INFO_BODY_WIDTH_PX = 569;

/** The body width plus the shell's inset on each side. */
export const CHAT_INFO_DRAWER_WIDTH_PX =
  CHAT_INFO_BODY_WIDTH_PX + 2 * DETAIL_SHELL_BODY_INSET_PX;
