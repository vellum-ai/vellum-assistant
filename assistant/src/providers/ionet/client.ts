import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface IonetProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_IONET_BASE_URL = "https://api.intelligence.io.solutions/api/v1";

/**
 * IO Intelligence (io.net) serves an OpenAI chat-completions API with
 * Hugging Face-style `org/name` model ids, so it rides the shared
 * chat-completions client with its own default base URL.
 */
export class IonetProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: IonetProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_IONET_BASE_URL,
      providerName: "ionet",
      providerLabel: "IO Intelligence",
      streamTimeoutMs: options.streamTimeoutMs,
      // IO Intelligence serves DeepSeek- and GLM-style thinking models whose
      // reasoning arrives as `reasoning_content`; replay it there so
      // follow-up requests that include tools stay acceptable upstream.
      assistantReasoningField: "reasoning_content",
      // io.net defaults an unspecified `tool_choice` to "none" (unlike
      // OpenAI's "auto"), so tools offered without an explicit choice must
      // still send one or the model could never invoke them.
      defaultToolChoiceAuto: true,
    });
  }
}
