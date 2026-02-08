import { NextResponse } from "next/server";

import { deleteAgentMailInbox, deleteAgentMailWebhook } from "@/lib/agentmail";
import { Agent, getDb } from "@/lib/db";
import { deleteInstance } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: agentId } = await params;

    const sql = getDb();
    const result = await sql`SELECT * FROM agents WHERE id = ${agentId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const agent = result[0] as Agent;
    const computeConfig = (agent.configuration as Record<string, unknown>)?.compute as
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

    const agentmailConfig = (agent.configuration as Record<string, unknown>)?.agentmail as
      | { inbox_id?: string; webhook_id?: string }
      | undefined;

    if (agentmailConfig) {
      try {
        if (agentmailConfig.webhook_id) {
          await deleteAgentMailWebhook(agentmailConfig.webhook_id);
          console.log(`Deleted AgentMail webhook ${agentmailConfig.webhook_id}`);
        }
        if (agentmailConfig.inbox_id) {
          await deleteAgentMailInbox(agentmailConfig.inbox_id);
          console.log(`Deleted AgentMail inbox ${agentmailConfig.inbox_id}`);
        }
      } catch (mailError: unknown) {
        console.warn("Failed to delete AgentMail resources, continuing:", mailError);
      }
    }

    await sql`DELETE FROM agents WHERE id = ${agentId}`;

    return NextResponse.json({
      success: true,
      message: "Agent, compute instance, and email resources deleted",
    });
  } catch (error: unknown) {
    console.error("Error killing agent:", error);
    return NextResponse.json(
      { error: "Failed to kill agent" },
      { status: 500 }
    );
  }
}
