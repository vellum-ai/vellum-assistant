export type ChatConnectingReason =
  | "auth_loading"
  | "assistant_loading"
  | "auto_greet_pending";

export function resolveChatConnectingReason({
  authLoading,
  assistantStateKind,
  autoGreetPending,
}: {
  authLoading: boolean;
  assistantStateKind: string;
  autoGreetPending: boolean;
}): ChatConnectingReason | null {
  if (authLoading) return "auth_loading";
  if (assistantStateKind === "loading") return "assistant_loading";
  if (autoGreetPending) return "auto_greet_pending";
  return null;
}
