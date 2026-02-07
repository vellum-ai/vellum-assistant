import { NextRequest, NextResponse } from "next/server";

import { createAgentMailInbox, registerAgentMailWebhook } from "@/lib/agentmail";
import { Agent, getDb } from "@/lib/db";

/**
 * POST /api/agents/[id]/setup-email
 * 
 * Allows an agent to set up its own email inbox.
 * Requires API key authentication via X-API-Key header.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: agentId } = await params;
  const apiKey = request.headers.get("X-API-Key");

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing X-API-Key header" },
      { status: 401 }
    );
  }

  try {
    const sql = getDb();

    // Fetch agent and verify API key
    const result = await sql`SELECT * FROM agents WHERE id = ${agentId}`;
    if (result.length === 0) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    const agent = result[0] as Agent;
    const storedApiKey = (agent.configuration as Record<string, unknown>)?.apiKey;

    if (!storedApiKey || storedApiKey !== apiKey) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
      );
    }

    // Check if email is already set up
    const existingMail = (agent.configuration as Record<string, unknown>)?.agentmail;
    if (existingMail) {
      return NextResponse.json({
        message: "Email already configured",
        agentmail: existingMail,
      });
    }

    // Set up AgentMail inbox
    console.log(`[Setup Email] Creating inbox for agent ${agentId} (${agent.name})`);
    const inbox = await createAgentMailInbox(agent.name, agentId);
    const webhook = await registerAgentMailWebhook(inbox.inbox_id);

    const agentmailConfig = {
      inbox_id: inbox.inbox_id,
      pod_id: inbox.pod_id,
      webhook_id: webhook.webhook_id,
    };

    // Update agent configuration
    await sql`
      UPDATE agents
      SET configuration = ${JSON.stringify({
        ...agent.configuration,
        agentmail: agentmailConfig,
      })},
      updated_at = NOW()
      WHERE id = ${agentId}
    `;

    console.log(`[Setup Email] Email configured for agent ${agentId}: inbox ${inbox.inbox_id}`);

    return NextResponse.json({
      message: "Email configured successfully",
      agentmail: agentmailConfig,
    });
  } catch (error) {
    console.error("[Setup Email] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to setup email";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

/**
 * GET /api/agents/[id]/setup-email
 * 
 * Check email setup status for an agent.
 * Requires API key authentication.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: agentId } = await params;
  const apiKey = request.headers.get("X-API-Key");

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing X-API-Key header" },
      { status: 401 }
    );
  }

  try {
    const sql = getDb();

    const result = await sql`SELECT * FROM agents WHERE id = ${agentId}`;
    if (result.length === 0) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    const agent = result[0] as Agent;
    const storedApiKey = (agent.configuration as Record<string, unknown>)?.apiKey;

    if (!storedApiKey || storedApiKey !== apiKey) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
      );
    }

    const agentmail = (agent.configuration as Record<string, unknown>)?.agentmail;

    return NextResponse.json({
      configured: !!agentmail,
      agentmail: agentmail || null,
    });
  } catch (error) {
    console.error("[Setup Email] Error:", error);
    return NextResponse.json(
      { error: "Failed to check email status" },
      { status: 500 }
    );
  }
}
