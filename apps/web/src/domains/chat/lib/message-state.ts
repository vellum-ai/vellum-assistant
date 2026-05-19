import type { SetStateAction } from "react";

import { dedupeDisplayMessages, type DisplayMessage } from "@/domains/chat/lib/reconcile.js";

export function dedupingMessagesReducer(
  state: DisplayMessage[],
  action: SetStateAction<DisplayMessage[]>,
): DisplayMessage[] {
  const next =
    typeof action === "function"
      ? (action as (prevState: DisplayMessage[]) => DisplayMessage[])(state)
      : action;
  return dedupeDisplayMessages(next);
}
