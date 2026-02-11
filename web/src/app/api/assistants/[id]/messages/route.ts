import { NextRequest, NextResponse } from "next/server";

import {
  getAssistantConnectionMode,
} from "@/lib/assistant-connection";
import {
  Assistant,
  ChatAttachment,
  ChatMessage,
  createChatMessage,
  getAttachmentsForMessages,
  getChatAttachmentsByIdsAndAssistant,
  getDb,
  getChatMessages,
  getMessageByGcsId,
  linkAttachmentsToMessage,
} from "@/lib/db";
import { buildAttachmentFallbackText } from "@/lib/attachments";
import { getInstanceExternalIp } from "@/lib/gcp";
import { createRuntimeClient, RuntimeClientError } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

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
  content?: unknown;
  attachment_ids?: unknown;
  sourceChannel?: unknown;
}

interface MessageAttachmentPayload {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
}

interface MessagePayload {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date | null;
  attachments: MessageAttachmentPayload[];
}

const GREETING_MESSAGE = "Hey there! I just hatched 🐣\n\nWhat's your name? And while we're at it — what should I call myself?";
const GITHUB_APP_HTML = `<div style="border:1px solid #d0d7de;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:600px;background:#fff">
  <div style="background:#24292f;padding:16px 24px;display:flex;align-items:center;gap:12px">
    <svg height="32" viewBox="0 0 16 16" width="32" fill="#fff"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    <span style="color:#fff;font-size:18px;font-weight:600">GitHub Apps</span>
  </div>
  <div style="padding:32px 24px;text-align:center">
    <div style="width:80px;height:80px;border-radius:16px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);margin:0 auto 16px;display:flex;align-items:center;justify-content:center">
      <span style="font-size:36px;color:#fff;font-weight:700">VJ</span>
    </div>
    <h2 style="margin:0 0 4px;font-size:24px;color:#24292f">Vargas JR</h2>
    <p style="margin:0 0 20px;color:#57606a;font-size:14px">by vellum-ai</p>
    <div style="display:inline-block;background:#2da44e;color:#fff;padding:8px 24px;border-radius:6px;font-size:14px;font-weight:600;margin-bottom:20px">✓ Installed</div>
    <div style="border-top:1px solid #d0d7de;padding-top:20px;margin-top:8px">
      <div style="display:flex;justify-content:center;gap:32px;color:#57606a;font-size:13px">
        <div><strong style="color:#24292f;display:block;font-size:18px">1</strong>repository</div>
        <div><strong style="color:#24292f;display:block;font-size:18px">12</strong>permissions</div>
        <div><strong style="color:#24292f;display:block;font-size:18px">3</strong>events</div>
      </div>
    </div>
    <div style="margin-top:20px;padding:12px 16px;background:#dafbe1;border-radius:6px;text-align:left;font-size:13px;color:#1a7f37">
      <strong>Active</strong> — This app is installed on <strong>vellum-ai/vellum-assistant</strong> with read &amp; write access to code, pull requests, and issues.
    </div>
  </div>
</div>`;


function getCannedResponse(assistantMessageCount: number): { content: string; action?: string } {
  switch (assistantMessageCount) {
    case 0:
      return {
        content: "I love it — Vargas JR it is! Nice to meet you. 😎\n\nSo, what would you like me to do first?",
        action: "rename",
      };
    case 1:
      return {
        content: "Done! I just made the background red for you. 🔴\n\nWhat else would you like me to do?",
        action: "background",
      };
    case 2:
      return {
        content: `On it! I just registered myself as a GitHub App and installed it on your repo.\n\nHere's the proof:\n\n${GITHUB_APP_HTML}\n\nI now have access to open PRs, review code, and respond to issues on your behalf. What should I work on first?`,
        action: "github",
      };
    default:
      return { content: "Got it! What's next?" };
  }
}

function toAttachmentPayload(attachment: ChatAttachment): MessageAttachmentPayload {
  return {
    id: attachment.id,
    original_filename: attachment.originalFilename,
    mime_type: attachment.mimeType,
    size_bytes: attachment.sizeBytes,
    kind: attachment.kind,
  };
}

function normalizeAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return [...new Set(ids)];
}

function buildForwardedContent(
  content: string,
  attachments: ChatAttachment[],
): string {
  if (attachments.length === 0) {
    return content;
  }

  const fallbackText = buildAttachmentFallbackText(
    attachments.map((attachment) => ({
      fileName: attachment.originalFilename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      kind: attachment.kind === "image" ? "image" : "document",
      extractedText: attachment.extractedText,
    })),
  );

  if (!content) {
    return fallbackText;
  }
  return `${fallbackText}\n\n${content}`;
}

async function buildMessagePayloads(messages: ChatMessage[]): Promise<MessagePayload[]> {
  const attachmentsByMessageId = await getAttachmentsForMessages(messages.map((msg) => msg.id));
  return messages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant",
    content: msg.content,
    timestamp: msg.createdAt,
    attachments: (attachmentsByMessageId.get(msg.id) ?? []).map(toAttachmentPayload),
  }));
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
    const connectionMode = getAssistantConnectionMode();

    if (connectionMode === "local") {
      try {
        const { baseUrl } = resolveRuntime(assistantId);
        const client = createRuntimeClient(baseUrl, assistantId);
        const conversationKey = assistantId; // use assistant ID as default conversation key
        const result = await client.listMessages({ conversationKey });

        return NextResponse.json({
          messages: result.messages,
          errors: [],
          connectionMode: "local",
        });
      } catch (error: unknown) {
        console.error("Error fetching local runtime messages:", error);
        const status = error instanceof RuntimeClientError ? error.status : 502;
        return NextResponse.json(
          { error: "Failed to fetch messages from local runtime", connectionMode: "local" },
          { status },
        );
      }
    }

    // In local dev, return a hardcoded greeting if no messages exist yet
    if (process.env.NODE_ENV !== "production") {
      const localMessages = await getChatMessages(assistantId);
      const formattedMessages = await buildMessagePayloads(localMessages);

      if (formattedMessages.length === 0) {
        formattedMessages.push({
          id: "local-greeting",
          role: "assistant" as const,
          content: `Hey there! I just hatched 🐣\n\nWhat's your name? And while we're at it — what should I call myself?`,
          timestamp: new Date(),
          attachments: [],
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

    const dbMessages = await getChatMessages(assistantId);
    const formattedMessages = await buildMessagePayloads(dbMessages);

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
        attachments: [],
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
    const body = await request.json() as PostMessageBody;
    const sourceChannel =
      typeof body.sourceChannel === "string" ? body.sourceChannel : "web";
    const content = typeof body.content === "string" ? body.content : "";
    const trimmedContent = content.trim();
    const attachmentIds = normalizeAttachmentIds(body.attachment_ids);

    if (sourceChannel !== "web") {
      return NextResponse.json({
        error: "Unsupported source channel for this endpoint",
      }, { status: 400 });
    }

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const assistant = result[0] as Assistant;
    const fetchedAttachments = attachmentIds.length > 0
      ? await getChatAttachmentsByIdsAndAssistant(attachmentIds, assistantId)
      : [];

    const attachmentsById = new Map(fetchedAttachments.map((attachment) => [attachment.id, attachment]));
    const attachments = attachmentIds
      .map((attachmentId) => attachmentsById.get(attachmentId))
      .filter((attachment): attachment is ChatAttachment => Boolean(attachment));

    if (!trimmedContent && attachmentIds.length === 0) {
      return NextResponse.json(
        { error: "Either content or attachment_ids is required" },
        { status: 400 }
      );
    }

    if (attachments.length !== attachmentIds.length) {
      return NextResponse.json(
        { error: "One or more attachment_ids are invalid for this assistant" },
        { status: 400 }
      );
    }

    const connectionMode = getAssistantConnectionMode();

    if (connectionMode === "local") {
      try {
        const { baseUrl } = resolveRuntime(assistantId);
        const client = createRuntimeClient(baseUrl, assistantId);
        const conversationKey = assistantId; // use assistant ID as default conversation key

        const result = await client.sendMessage({
          conversationKey,
          content,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        });

        return NextResponse.json({
          success: true,
          connectionMode: "local",
          messageId: result.messageId,
          ...(result.assistantMessage ? { assistantMessage: result.assistantMessage } : {}),
          message: "Message processed by local runtime",
        });
      } catch (error: unknown) {
        console.error("Error sending local runtime message:", error);
        const status = error instanceof RuntimeClientError ? error.status : 502;
        return NextResponse.json(
          { error: "Failed to send message to local runtime", connectionMode: "local" },
          { status },
        );
      }
    }

    const forwardedContent = buildForwardedContent(content, attachments);
    const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    // If no compute instance, use canned responses (demo mode)
    if (!computeConfig?.instanceName) {
      const userMessage = await createChatMessage({
        assistantId,
        role: "user",
        content,
        status: "sent",
      });
      if (attachmentIds.length > 0) {
        await linkAttachmentsToMessage(userMessage.id, attachmentIds);
      }

      // Count user messages to determine which canned response to give
      const existingMessages = await getChatMessages(assistantId);
      const userMessageCount = existingMessages.filter(
        (m: ChatMessage) => m.role === "user"
      ).length;

      const { content: responseContent, action } = getCannedResponse(userMessageCount - 1);

      if (action === "rename") {
        await sql`UPDATE assistants SET name = 'Vargas JR', updated_at = NOW() WHERE id = ${assistantId}`;
      } else if (action === "background") {
        const config = (assistant.configuration as Record<string, unknown>) || {};
        await sql`
          UPDATE assistants
          SET configuration = ${JSON.stringify({ ...config, ui: { backgroundColor: "#dc2626" } })},
              updated_at = NOW()
          WHERE id = ${assistantId}
        `;
      }

      // Simulate a slight delay before the assistant "responds"
      await new Promise(resolve => setTimeout(resolve, 1500));

      const assistantMsg = await createChatMessage({
        assistantId,
        role: "assistant",
        content: responseContent,
        status: "delivered",
      });

      return NextResponse.json({
        success: true,
        assistantMessage: {
          id: assistantMsg.id,
          role: "assistant",
          content: responseContent,
          timestamp: assistantMsg.createdAt,
        },
      });
    }

    // Forward to compute instance
    const externalIp = await getInstanceExternalIp(
      computeConfig.instanceName,
      computeConfig.zone!
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
      body: JSON.stringify({ content: forwardedContent }),
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
      sourceChannel,
      gcsMessageId: assistantData.messageId,
    });
    if (attachmentIds.length > 0) {
      await linkAttachmentsToMessage(dbMessage.id, attachmentIds);
    }

    return NextResponse.json({
      success: true,
      messageId: dbMessage.id,
      message: "Message sent to assistant inbox",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to send message";
    console.error("Error sending message:", error);

    if (message === "Assistant not found" || message === "Agent not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message === "Message content is required") {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Failed to send message" },
      { status: 500 }
    );
  }
}
