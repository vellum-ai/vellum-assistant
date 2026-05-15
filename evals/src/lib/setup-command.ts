export type SeededConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type TestSetupCommand = {
  /**
   * Seed pre-existing conversation history without asking the live agent LLM to
   * respond. Each adapter bridges this into its own runtime representation.
   */
  type: "seed-conversation";
  messages: SeededConversationMessage[];
};
