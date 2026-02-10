import { NextRequest, NextResponse } from "next/server";

import { handleInboundAssistantMessage } from "@/lib/assistants/message-service";
import {
  Assistant,
  ChatMessage,
  createChatMessage,
  getChatMessages,
  getDb,
  getMessageByGcsId,
} from "@/lib/db";
import { getInstanceExternalIp } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface OutboxMessage {
  id: string;
  content: string;
  status: string;
  createdAt: string;
  sender: string;
}

interface AssistantError {
  timestamp: string;
  message: string;
}

interface PostMessageBody {
  content?: string;
  sourceChannel?: string;
  externalChatId?: string;
  externalMessageId?: string;
  sender?: {
    externalUserId?: string;
    username?: string;
    displayName?: string;
  };
}

const GREETING_MESSAGE =
  "Hey there! I just hatched 🐣\n\nWhat's your name? And while we're at it — what should I call myself?";

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const assistant = result[0] as Assistant;

    // In local dev, return a hardcoded greeting if no messages exist yet
    if (process.env.NODE_ENV !== "production") {
      const localMessages = await getChatMessages(assistantId);
      const formattedMessages = localMessages.map((msg: ChatMessage) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.createdAt,
      }));

      if (formattedMessages.length === 0) {
        formattedMessages.push({
          id: "local-greeting",
          role: "assistant" as const,
          content: GREETING_MESSAGE,
          timestamp: new Date(),
        });
      }

      return NextResponse.json({ messages: formattedMessages, errors: [] });
    }

    const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    // Sync messages from compute instance outbox if available
    if (computeConfig?.instanceName && computeConfig?.zone) {
      try {
        const externalIp = await getInstanceExternalIp(
          computeConfig.instanceName,
          computeConfig.zone
        );

        if (externalIp) {
          const outboxResponse = await fetch(`http://${externalIp}:8080/outbox`);

          if (outboxResponse.ok) {
            const outboxData = await outboxResponse.json();
            const outboxMessages: OutboxMessage[] = outboxData.messages || [];

            for (const outboxMsg of outboxMessages) {
              if (outboxMsg.status === "queued" || outboxMsg.status === "sent") {
                const existingMsg = await getMessageByGcsId(outboxMsg.id);
                if (!existingMsg) {
                  await createChatMessage({
                    assistantId,
                    role: "assistant",
                    content: outboxMsg.content,
                    status: "delivered",
                    gcsMessageId: outboxMsg.id,
                  });
                }
              }
            }
          }
        }
      } catch (error: unknown) {
        console.error("Failed to sync messages from assistant outbox:", error);
      }
    }

    const dbMessages = await getChatMessages(assistantId);
    const formattedMessages = dbMessages.map((msg: ChatMessage) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.createdAt,
    }));

    // If no messages exist yet, persist and show a greeting
    if (formattedMessages.length === 0) {
      const greeting = await createChatMessage({
        assistantId,
        role: "assistant",
        content: GREETING_MESSAGE,
        status: "delivered",
      });
      formattedMessages.push({
        id: greeting.id,
        role: "assistant" as const,
        content: GREETING_MESSAGE,
        timestamp: greeting.createdAt,
      });
    }

    // Fetch recent errors from the assistant (only if compute is configured)
    let recentErrors: AssistantError[] = [];
    if (computeConfig?.instanceName && computeConfig?.zone) {
      try {
        const externalIp = await getInstanceExternalIp(
          computeConfig.instanceName,
          computeConfig.zone
        );

        if (externalIp) {
          const errorsResponse = await fetch(`http://${externalIp}:8080/errors?limit=5`);

          if (errorsResponse.ok) {
            const errorsData = await errorsResponse.json();
            recentErrors = errorsData.errors || [];
          }
        }
      } catch (error: unknown) {
        console.error("Failed to fetch errors from assistant:", error);
      }
    }

    return NextResponse.json({ messages: formattedMessages, errors: recentErrors });
  } catch (error: unknown) {
    console.error("Error fetching messages:", error);
    return NextResponse.json({ error: "Failed to fetch messages" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    const body = (await request.json()) as PostMessageBody;

    if (!body.content || typeof body.content !== "string") {
      return NextResponse.json(
        { error: "Message content is required" },
        { status: 400 }
      );
    }

    const result = await handleInboundAssistantMessage({
      assistantId,
      content: body.content,
      sourceChannel: body.sourceChannel || "web",
      externalChatId: body.externalChatId,
      externalMessageId: body.externalMessageId,
      sender: body.sender,
    });

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate,
      messageId: result.userMessage?.id ?? null,
      assistantMessage: result.assistantMessage,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send message";
    console.error("Error sending message:", error);

    if (message === "Assistant not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message === "Message content is required") {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
