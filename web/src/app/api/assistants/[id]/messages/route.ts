import { NextRequest, NextResponse } from "next/server";

import {
  Assistant,
  ChatMessage,
  createChatMessage,
  getDb,
  getChatMessages,
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

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const assistant = result[0] as Assistant;
    const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    if (computeConfig?.instanceName && computeConfig?.zone) {
      try {
        const externalIp = await getInstanceExternalIp(
          computeConfig.instanceName,
          computeConfig.zone
        );

        if (externalIp) {
          const outboxResponse = await fetch(
            `http://${externalIp}:8080/outbox`
          );

          if (outboxResponse.ok) {
            const outboxData = await outboxResponse.json();
            const outboxMessages: OutboxMessage[] = outboxData.messages || [];

            for (const outboxMsg of outboxMessages) {
              if (
                outboxMsg.status === "queued" ||
                outboxMsg.status === "sent"
              ) {
                const existingMsg = await getMessageByGcsId(outboxMsg.id);
                if (!existingMsg) {
                  await createChatMessage({
                    assistantId: assistantId,
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

    const updatedMessages = await getChatMessages(assistantId);
    const formattedMessages = updatedMessages.map((msg: ChatMessage) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.createdAt,
    }));

    // Fetch recent errors from the assistant
    let recentErrors: AssistantError[] = [];
    if (computeConfig?.instanceName && computeConfig?.zone) {
      try {
        const externalIp = await getInstanceExternalIp(
          computeConfig.instanceName,
          computeConfig.zone
        );

        if (externalIp) {
          const errorsResponse = await fetch(
            `http://${externalIp}:8080/errors?limit=5`
          );

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
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== "string") {
      return NextResponse.json(
        { error: "Message content is required" },
        { status: 400 }
      );
    }

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const assistant = result[0] as Assistant;
    const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    if (!computeConfig?.instanceName || !computeConfig?.zone) {
      return NextResponse.json(
        { error: "Agent compute configuration not found" },
        { status: 400 }
      );
    }

    const externalIp = await getInstanceExternalIp(
      computeConfig.instanceName,
      computeConfig.zone
    );

    if (!externalIp) {
      return NextResponse.json(
        { error: "Agent instance not reachable - no external IP" },
        { status: 503 }
      );
    }

    const assistantResponse = await fetch(`http://${externalIp}:8080/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (!assistantResponse.ok) {
      const errorData = await assistantResponse.json().catch(() => ({}));
      return NextResponse.json(
        { error: errorData.error || "Failed to send message to assistant" },
        { status: assistantResponse.status }
      );
    }

    const assistantData = await assistantResponse.json();

    const dbMessage = await createChatMessage({
      assistantId: assistantId,
      role: "user",
      content,
      status: "sent",
      gcsMessageId: assistantData.messageId,
    });

    return NextResponse.json({
      success: true,
      messageId: dbMessage.id,
      message: "Message sent to assistant inbox",
    });
  } catch (error: unknown) {
    console.error("Error sending message:", error);
    return NextResponse.json(
      { error: "Failed to send message" },
      { status: 500 }
    );
  }
}
