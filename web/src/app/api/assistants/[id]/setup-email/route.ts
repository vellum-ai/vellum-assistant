import { NextRequest, NextResponse } from "next/server";

import { createAssistantMailInbox, registerAssistantMailWebhook } from "@/lib/agentmail";
import { verifyAssistantToken } from "@/lib/auth/assistant-tokens";
import { Assistant, getDb } from "@/lib/db";

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice(7);
}

/**
 * POST /api/assistants/[id]/setup-email
 *
 * Allows an assistant to set up its own email inbox.
 * Requires bearer token authentication via Authorization header.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assistantId } = await params;
  const token = extractBearerToken(request);

  if (!token) {
    return NextResponse.json(
      { error: "Missing or invalid Authorization header" },
      { status: 401 }
    );
  }

  try {
    const verified = await verifyAssistantToken(assistantId, token);
    if (!verified) {
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401 }
      );
    }

    const sql = getDb();

    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;
    if (result.length === 0) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    const assistant = result[0] as Assistant;

    // Check if email is already set up
    const existingMail = (assistant.configuration as Record<string, unknown>)?.agentmail;
    if (existingMail) {
      return NextResponse.json({
        message: "Email already configured",
        agentmail: existingMail,
      });
    }

    // Set up AgentMail inbox
    console.log(`[Setup Email] Creating inbox for assistant ${assistantId} (${assistant.name})`);
    const inbox = await createAssistantMailInbox(assistant.name, assistantId);
    const webhook = await registerAssistantMailWebhook(inbox.inbox_id);

    const agentmailConfig = {
      inbox_id: inbox.inbox_id,
      pod_id: inbox.pod_id,
      webhook_id: webhook.webhook_id,
    };

    // Update assistant configuration
    await sql`
      UPDATE assistants
      SET configuration = ${JSON.stringify({
        ...(assistant.configuration as Record<string, unknown> || {}),
        agentmail: agentmailConfig,
      })},
      updated_at = NOW()
      WHERE id = ${assistantId}
    `;

    console.log(`[Setup Email] Email configured for assistant ${assistantId}: inbox ${inbox.inbox_id}`);

    return NextResponse.json({
      message: "Email configured successfully",
      agentmail: agentmailConfig,
    });
  } catch (error: unknown) {
    console.error("[Setup Email] Error:", error);
    return NextResponse.json(
      { error: "Failed to setup email" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/assistants/[id]/setup-email
 *
 * Check email setup status for an assistant.
 * Requires bearer token authentication.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assistantId } = await params;
  const token = extractBearerToken(request);

  if (!token) {
    return NextResponse.json(
      { error: "Missing or invalid Authorization header" },
      { status: 401 }
    );
  }

  try {
    const verified = await verifyAssistantToken(assistantId, token);
    if (!verified) {
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401 }
      );
    }

    const sql = getDb();

    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;
    if (result.length === 0) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    const assistant = result[0] as Assistant;
    const agentmail = (assistant.configuration as Record<string, unknown>)?.agentmail;

    return NextResponse.json({
      configured: !!agentmail,
      agentmail: agentmail || null,
    });
  } catch (error: unknown) {
    console.error("[Setup Email] Error:", error);
    return NextResponse.json(
      { error: "Failed to check email status" },
      { status: 500 }
    );
  }
}
