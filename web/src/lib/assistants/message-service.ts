import Anthropic from "@anthropic-ai/sdk";

import {
  ChatMessage,
  createChatMessage,
  getAssistantById,
  getMessageByExternalId,
  getRecentChatMessages,
} from "@/lib/db";

export interface InboundMessageSender {
  externalUserId?: string;
  username?: string;
  displayName?: string;
}

export interface HandleInboundAssistantMessageInput {
  assistantId: string;
  content: string;
  sourceChannel?: string;
  externalChatId?: string;
  externalMessageId?: string;
  sender?: InboundMessageSender;
}

export interface HandleInboundAssistantMessageResult {
  duplicate: boolean;
  userMessage: {
    id: string;
    role: "user";
    content: string;
    timestamp: Date | null;
  } | null;
  assistantMessage: {
    id: string;
    role: "assistant";
    content: string;
    timestamp: Date | null;
  } | null;
}

const DEFAULT_ASSISTANT_MODEL = process.env.ANTHROPIC_ASSISTANT_MODEL || "claude-opus-4-6";

function buildSystemPrompt(assistantName: string) {
  return [
    `You are ${assistantName}, an AI assistant chatting with a user.`,
    "Be helpful, concise, and conversational.",
    "Keep answers focused and practical.",
  ].join(" ");
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    }));
}

async function generateAssistantReply(params: {
  assistantName: string;
  messages: ChatMessage[];
}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return "I got your message, but my AI provider is not configured yet.";
  }

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: DEFAULT_ASSISTANT_MODEL,
    max_tokens: 1200,
    system: buildSystemPrompt(params.assistantName),
    messages: toAnthropicMessages(params.messages),
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return text || "I couldn't generate a response yet. Please try again.";
}

export async function handleInboundAssistantMessage(
  input: HandleInboundAssistantMessageInput
): Promise<HandleInboundAssistantMessageResult> {
  const sourceChannel = input.sourceChannel || "web";
  const content = input.content.trim();
  if (!content) {
    throw new Error("Message content is required");
  }

  const assistant = await getAssistantById(input.assistantId);
  if (!assistant) {
    throw new Error("Assistant not found");
  }

  if (input.externalMessageId) {
    const existing = await getMessageByExternalId(
      input.assistantId,
      sourceChannel,
      input.externalMessageId
    );
    if (existing) {
      return {
        duplicate: true,
        userMessage: null,
        assistantMessage: null,
      };
    }
  }

  const userMessage = await createChatMessage({
    assistantId: input.assistantId,
    role: "user",
    content,
    status: "sent",
    sourceChannel,
    externalChatId: input.externalChatId,
    externalMessageId: input.externalMessageId,
    metadata: {
      sender: {
        externalUserId: input.sender?.externalUserId ?? null,
        username: input.sender?.username ?? null,
        displayName: input.sender?.displayName ?? null,
      },
    },
  });

  const contextMessages = await getRecentChatMessages(input.assistantId, 40);
  let assistantReply: string;
  try {
    assistantReply = await generateAssistantReply({
      assistantName: assistant.name,
      messages: contextMessages,
    });
  } catch (error) {
    console.error("Failed to generate assistant reply:", error);
    assistantReply =
      "I ran into an issue while thinking through that. Please try again in a moment.";
  }

  const assistantMessage = await createChatMessage({
    assistantId: input.assistantId,
    role: "assistant",
    content: assistantReply,
    status: "delivered",
    sourceChannel,
    externalChatId: input.externalChatId,
    metadata: {
      replyToUserMessageId: userMessage.id,
    },
  });

  return {
    duplicate: false,
    userMessage: {
      id: userMessage.id,
      role: "user",
      content: userMessage.content,
      timestamp: userMessage.createdAt,
    },
    assistantMessage: {
      id: assistantMessage.id,
      role: "assistant",
      content: assistantMessage.content,
      timestamp: assistantMessage.createdAt,
    },
  };
}
