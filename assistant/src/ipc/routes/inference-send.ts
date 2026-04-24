import {
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import type { IpcRoute } from "../cli-server.js";

interface InferenceSendRequest {
  message: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
}

export interface InferenceSendResponse {
  text: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

async function inferenceSendHandler(
  params?: Record<string, unknown>,
): Promise<InferenceSendResponse> {
  const req = params as unknown as InferenceSendRequest;

  const provider = await getConfiguredProvider("inference");
  if (!provider) {
    throw new Error(
      "No LLM provider is configured. Run 'assistant config set llm.default.provider <provider>' to set one up.",
    );
  }

  const response = await provider.sendMessage(
    [userMessage(req.message)],
    undefined,
    req.systemPrompt,
    {
      config: {
        callSite: "inference",
        max_tokens: req.maxTokens,
        model: req.model,
      },
    },
  );

  const text = extractAllText(response);

  return {
    text,
    model: response.model,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    },
  };
}

export const inferenceSendRoute: IpcRoute = {
  method: "inference_send",
  handler: inferenceSendHandler,
};
