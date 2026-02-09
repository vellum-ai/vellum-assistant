import { NextResponse } from "next/server";

import { Assistant, getDb } from "@/lib/db";
import { getInstanceExternalIp } from "@/lib/gcp";

interface AgentMailWebhookMessage {
  from_: string[];
  organization_id: string;
  inbox_id: string;
  thread_id: string;
  message_id: string;
  labels: string[];
  timestamp: string;
  reply_to: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  preview: string;
  text: string;
  html: string;
  attachments: {
    attachment_id: string;
    filename: string;
    content_type: string;
    size: number;
    inline: boolean;
  }[];
  in_reply_to: string;
  references: string[];
  sort_key: string;
  updated_at: string;
  created_at: string;
}

interface AgentMailWebhookPayload {
  event_type: string;
  event_id: string;
  message: AgentMailWebhookMessage;
}

export async function POST(request: Request) {
  try {
    const payload: AgentMailWebhookPayload = await request.json();

    if (payload.event_type !== "message.received") {
      return NextResponse.json({ status: "ignored" });
    }

    const inboxId = payload.message.inbox_id;
    const sql = getDb();
    const assistants = await sql`
      SELECT * FROM assistants
      WHERE configuration->'agentmail'->>'inbox_id' = ${inboxId}
    `;

    if (assistants.length === 0) {
      console.error(`No agent found for inbox_id: ${inboxId}`);
      return NextResponse.json(
        { error: "No agent found for this inbox" },
        { status: 404 }
      );
    }

    const agent = assistants[0] as Assistant;
    const computeConfig = (agent.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    if (!computeConfig?.instanceName || !computeConfig?.zone) {
      console.error(`Agent ${agent.id} has no compute instance configured`);
      return NextResponse.json(
        { error: "Agent compute instance not configured" },
        { status: 503 }
      );
    }

    const externalIp = await getInstanceExternalIp(
      computeConfig.instanceName,
      computeConfig.zone
    );

    if (!externalIp) {
      console.error(`Agent ${agent.id} instance has no external IP`);
      return NextResponse.json(
        { error: "Agent instance not reachable" },
        { status: 503 }
      );
    }

    const agentResponse = await fetch(
      `http://${externalIp}:8080/inbox/email`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (!agentResponse.ok) {
      const errorText = await agentResponse.text().catch(() => "Unknown error");
      console.error(
        `Agent server rejected email (${agentResponse.status}): ${errorText}`
      );
      return NextResponse.json(
        { error: "Agent server rejected the email" },
        { status: agentResponse.status }
      );
    }

    console.log(
      `Forwarded email ${payload.message.message_id} to agent ${agent.id}`
    );
    return NextResponse.json({ status: "ok" });
  } catch (error: unknown) {
    console.error("Error processing AgentMail webhook:", error);
    return NextResponse.json(
      { error: "Failed to process webhook" },
      { status: 500 }
    );
  }
}
