import type { ConversationstartersGetResponse } from "@/generated/daemon/types.gen";

/** A single conversation starter chip, as returned by the daemon. */
export type ConversationStarter =
  ConversationstartersGetResponse["starters"][number];

export type ConversationStartersStatus =
  ConversationstartersGetResponse["status"];
