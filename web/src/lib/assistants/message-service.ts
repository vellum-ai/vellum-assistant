import Anthropic from "@anthropic-ai/sdk";

import {
  ChatMessage,
  getAssistantReplyByUserMessageId,
  createChatMessage,
  getAssistantById,
  getChatMessageById,
  getMessageByExternalId,
  getRecentConversationMessages,
  getRecentChatMessages,
  updateChatMessageStatus,
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
    status: string | null;
  } | null;
  assistantMessage: {
    id: string;
    role: "assistant";
    content: string;
    timestamp: Date | null;
    status: string | null;
  } | null;
}

const DEFAULT_ASSISTANT_MODEL = process.env.ANTHROPIC_ASSISTANT_MODEL || "claude-opus-4-6";

type AssistantMessageResult = NonNullable<
  HandleInboundAssistantMessageResult["assistantMessage"]
>;

function buildSystemPrompt(assistantName: string) {
  return [
    `You are ${assistantName}, an AI assistant chatting with a user.`,
    "Be helpful, concise, and conversational.",
    "Keep answers focused and practical.",
  ].join(" ");
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const filtered = messages.filter(
    (msg) => msg.role === "user" || msg.role === "assistant"
  );

  // Anthropic requires the first message to be from the user.
  const firstUserIndex = filtered.findIndex((msg) => msg.role === "user");
  const trimmed = firstUserIndex >= 0 ? filtered.slice(firstUserIndex) : [];

  // Anthropic expects role alternation; merge consecutive same-role messages.
  const merged: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const msg of trimmed) {
    const role = msg.role as "user" | "assistant";
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${msg.content}`;
      continue;
    }

    merged.push({ role, content: msg.content });
  }

  return merged;
}

async function generateAssistantReply(params: {
  assistantName: string;
  messages: ChatMessage[];
}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return "I got your message, but my AI provider is not configured yet.";
  }

  const anthropicMessages = toAnthropicMessages(params.messages);
  if (anthropicMessages.length === 0) {
    return "I couldn't generate a response yet. Please try again.";
  }

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: DEFAULT_ASSISTANT_MODEL,
    max_tokens: 1200,
    system: buildSystemPrompt(params.assistantName),
    messages: anthropicMessages,
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return text || "I couldn't generate a response yet. Please try again.";
}

function toAssistantMessageResult(message: ChatMessage): AssistantMessageResult {
  return {
    id: message.id,
    role: "assistant",
    content: message.content,
    timestamp: message.createdAt,
    status: message.status,
  };
}

function isExternalMessageDeduplicationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const postgresError = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    detail?: string;
  };
  if (postgresError.code !== "23505") {
    return false;
  }

  const constraint =
    postgresError.constraint ?? postgresError.constraint_name ?? "";
  return (
    constraint === "uniq_chat_messages_external" ||
    postgresError.detail?.includes("uniq_chat_messages_external") === true
  );
}

async function getReplyContext(params: {
  assistantId: string;
  sourceChannel: string;
  externalChatId?: string;
}) {
  if (params.externalChatId && params.sourceChannel !== "web") {
    return getRecentConversationMessages({
      assistantId: params.assistantId,
      sourceChannel: params.sourceChannel,
      externalChatId: params.externalChatId,
      limit: 40,
    });
  }

  return getRecentChatMessages(params.assistantId, 40);
}

async function safeGenerateAssistantReply(params: {
  assistantName: string;
  messages: ChatMessage[];
}) {
  try {
    return await generateAssistantReply(params);
  } catch (error) {
    console.error("Failed to generate assistant reply:", error);
    return "I ran into an issue while thinking through that. Please try again in a moment.";
  }
}

async function safeUpdateUserMessageStatus(
  userMessageId: string,
  status: string
) {
  try {
    await updateChatMessageStatus(userMessageId, status);
  } catch (error) {
    console.warn(`Failed to update user message status to ${status}:`, error);
  }
}

export async function recoverMissingAssistantReplyForInbound(params: {
  assistantId: string;
  sourceChannel: string;
  externalChatId?: string;
  userMessageId: string;
}): Promise<AssistantMessageResult> {
  const assistant = await getAssistantById(params.assistantId);
  if (!assistant) {
    throw new Error("Assistant not found");
  }

  const userMessage = await getChatMessageById(params.userMessageId);
  if (
    !userMessage ||
    userMessage.assistantId !== params.assistantId ||
    userMessage.role !== "user"
  ) {
    throw new Error("User message not found for reply recovery");
  }

  const existingAssistantReply = await getAssistantReplyByUserMessageId({
    assistantId: params.assistantId,
    sourceChannel: params.sourceChannel,
    externalChatId: params.externalChatId,
    userMessageId: params.userMessageId,
  });
  if (existingAssistantReply) {
    return toAssistantMessageResult(existingAssistantReply);
  }

  const contextMessages = await getReplyContext({
    assistantId: params.assistantId,
    sourceChannel: params.sourceChannel,
    externalChatId: params.externalChatId,
  });
  const assistantReply = await safeGenerateAssistantReply({
    assistantName: assistant.name,
    messages: contextMessages,
  });

  const assistantMessage = await createChatMessage({
    assistantId: params.assistantId,
    role: "assistant",
    content: assistantReply,
    status: "pending_delivery",
    sourceChannel: params.sourceChannel,
    externalChatId: params.externalChatId,
    metadata: {
      replyToUserMessageId: params.userMessageId,
    },
  });
  await safeUpdateUserMessageStatus(params.userMessageId, "processed");

  return toAssistantMessageResult(assistantMessage);
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
      input.externalChatId,
      input.externalMessageId
    );
    if (existing) {
      const existingAssistantReply = await getAssistantReplyByUserMessageId({
        assistantId: input.assistantId,
        sourceChannel,
        externalChatId: input.externalChatId,
        userMessageId: existing.id,
      });

      return {
        duplicate: true,
        userMessage: {
          id: existing.id,
          role: "user",
          content: existing.content,
          timestamp: existing.createdAt,
          status: existing.status,
        },
        assistantMessage: existingAssistantReply
          ? {
              id: existingAssistantReply.id,
              role: "assistant",
              content: existingAssistantReply.content,
              timestamp: existingAssistantReply.createdAt,
              status: existingAssistantReply.status,
            }
          : null,
      };
    }
  }

  let userMessage: ChatMessage;
  try {
    userMessage = await createChatMessage({
      assistantId: input.assistantId,
      role: "user",
      content,
      status: "processing",
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
  } catch (error) {
    if (input.externalMessageId && isExternalMessageDeduplicationError(error)) {
      const existing = await getMessageByExternalId(
        input.assistantId,
        sourceChannel,
        input.externalChatId,
        input.externalMessageId
      );
      if (existing) {
        const existingAssistantReply = await getAssistantReplyByUserMessageId({
          assistantId: input.assistantId,
          sourceChannel,
          externalChatId: input.externalChatId,
          userMessageId: existing.id,
        });

        return {
          duplicate: true,
          userMessage: {
            id: existing.id,
            role: "user",
            content: existing.content,
            timestamp: existing.createdAt,
            status: existing.status,
          },
          assistantMessage: existingAssistantReply
            ? {
                id: existingAssistantReply.id,
                role: "assistant",
                content: existingAssistantReply.content,
                timestamp: existingAssistantReply.createdAt,
                status: existingAssistantReply.status,
              }
            : null,
        };
      }
    }

    throw error;
  }

  const contextMessages = await getReplyContext({
    assistantId: input.assistantId,
    sourceChannel,
    externalChatId: input.externalChatId,
  });
  const assistantReply = await safeGenerateAssistantReply({
    assistantName: assistant.name,
    messages: contextMessages,
  });

  let assistantMessage: ChatMessage;
  try {
    assistantMessage = await createChatMessage({
      assistantId: input.assistantId,
      role: "assistant",
      content: assistantReply,
      status: "pending_delivery",
      sourceChannel,
      externalChatId: input.externalChatId,
      metadata: {
        replyToUserMessageId: userMessage.id,
      },
    });
  } catch (error) {
    await safeUpdateUserMessageStatus(userMessage.id, "generation_failed");
    throw error;
  }
  await safeUpdateUserMessageStatus(userMessage.id, "processed");

  return {
    duplicate: false,
    userMessage: {
      id: userMessage.id,
      role: "user",
      content: userMessage.content,
      timestamp: userMessage.createdAt,
      status: "processed",
    },
    assistantMessage: toAssistantMessageResult(assistantMessage),
  };
}
