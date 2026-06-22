export type SeededConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type TestSetupCommand =
  | {
      /**
       * Seed pre-existing conversation history without asking the live agent
       * LLM to respond. Each adapter bridges this into its own runtime
       * representation.
       */
      type: "seed-conversation";
      messages: SeededConversationMessage[];
    }
  | {
      /**
       * Stage a file into the agent's workspace before the conversation
       * starts, modelling a document the user "already uploaded". Adapters
       * bridge this onto their own writable workspace boundary; species that
       * expose none reject it. `path` is workspace-relative and must not
       * escape the workspace root.
       */
      type: "stage-workspace-file";
      path: string;
      content: string;
    };
