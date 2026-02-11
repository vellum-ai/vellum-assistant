import { NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { deleteAssistantMailInbox, deleteAssistantMailWebhook } from "@/lib/agentmail";
import { disconnectTelegramChannel } from "@/lib/channels/service";
import { getDb } from "@/lib/db";
import { deleteInstance } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    const { assistant } = await requireAssistantOwner(request, assistantId);

    const sql = getDb();
    const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    if (computeConfig?.instanceName && computeConfig?.zone) {
      const deleted = await deleteInstance(
        computeConfig.instanceName,
        computeConfig.zone
      );

      if (!deleted) {
        console.warn(
          `Failed to delete compute instance ${computeConfig.instanceName}, continuing with database deletion`
        );
      }
    }

    const agentmailConfig = (assistant.configuration as Record<string, unknown>)?.agentmail as
      | { inbox_id?: string; webhook_id?: string }
      | undefined;

    if (agentmailConfig) {
      try {
        if (agentmailConfig.webhook_id) {
          await deleteAssistantMailWebhook(agentmailConfig.webhook_id);
          console.log(`Deleted AgentMail webhook ${agentmailConfig.webhook_id}`);
        }
        if (agentmailConfig.inbox_id) {
          await deleteAssistantMailInbox(agentmailConfig.inbox_id);
          console.log(`Deleted AgentMail inbox ${agentmailConfig.inbox_id}`);
        }
      } catch (mailError: unknown) {
        console.warn("Failed to delete AgentMail resources, continuing:", mailError);
      }
    }

    try {
      await disconnectTelegramChannel(assistantId);
    } catch (channelError: unknown) {
      console.warn("Failed to disconnect Telegram channel, continuing:", channelError);
    }

    await sql`DELETE FROM assistants WHERE id = ${assistantId}`;

    return NextResponse.json({
      success: true,
      message: "Assistant, compute instance, and email resources deleted",
    });
  } catch (error: unknown) {
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    console.error("Error killing assistant:", error);
    return NextResponse.json(
      { error: "Failed to kill assistant" },
      { status: 500 }
    );
  }
}
