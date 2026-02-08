import { NextRequest, NextResponse } from "next/server";

import {
  Agent,
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

interface AgentError {
  timestamp: string;
  message: string;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: agentId } = await params;

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${agentId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const agent = result[0] as Agent;
    const computeConfig = (agent.configuration as Record<string, unknown>)?.compute as
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
                    assistantId: agentId,
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
        console.error("Failed to sync messages from agent outbox:", error);
      }
    }

    const updatedMessages = await getChatMessages(agentId);
    const formattedMessages = updatedMessages.map((msg: ChatMessage) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.createdAt,
    }));

    // Fetch recent errors from the agent
    let recentErrors: AgentError[] = [];
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
        console.error("Failed to fetch errors from agent:", error);
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
    const { id: agentId } = await params;
    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== "string") {
      return NextResponse.json(
        { error: "Message content is required" },
        { status: 400 }
      );
    }

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${agentId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const agent = result[0] as Agent;
    const computeConfig = (agent.configuration as Record<string, unknown>)?.compute as
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

    const agentResponse = await fetch(`http://${externalIp}:8080/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (!agentResponse.ok) {
      const errorData = await agentResponse.json().catch(() => ({}));
      return NextResponse.json(
        { error: errorData.error || "Failed to send message to agent" },
        { status: agentResponse.status }
      );
    }

    const agentData = await agentResponse.json();

    const dbMessage = await createChatMessage({
      assistantId: agentId,
      role: "user",
      content,
      status: "sent",
      gcsMessageId: agentData.messageId,
    });

    return NextResponse.json({
      success: true,
      messageId: dbMessage.id,
      message: "Message sent to agent inbox",
    });
  } catch (error: unknown) {
    console.error("Error sending message:", error);
    return NextResponse.json(
      { error: "Failed to send message" },
      { status: 500 }
    );
  }
}
