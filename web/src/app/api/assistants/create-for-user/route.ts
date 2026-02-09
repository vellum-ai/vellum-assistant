import crypto from "crypto";

import { NextRequest, NextResponse } from "next/server";

import { Agent, getDb } from "@/lib/db";
import {
  createAgentComputeInstance,
  uploadAgentConfigToGCS,
  uploadAgentToGCS,
  getAvailablePrequeuedInstance,
} from "@/lib/gcp";

const MAX_ASSISTANTS_PER_USER = 3;
const APP_URL = process.env.APP_URL || "http://localhost:3000";

/**
 * POST /api/assistants/create-for-user
 * 
 * Allows an agent to create a new agent for a user.
 * Requires API key authentication via X-API-Key header.
 * 
 * Body: {
 *   user_id: string,       // The user to create the agent for
 *   agent_name: string,    // Name for the new agent
 *   description?: string,  // Optional description
 * }
 * 
 * Returns: {
 *   agent: Agent,
 *   link: string,          // Link to the new agent's page
 * }
 */
export async function POST(request: NextRequest) {
  const apiKey = request.headers.get("X-API-Key");

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing X-API-Key header" },
      { status: 401 }
    );
  }

  try {
    const sql = getDb();

    // Verify the API key belongs to a valid agent
    const callingAgentResult = await sql`
      SELECT * FROM assistants 
      WHERE configuration->>'apiKey' = ${apiKey}
      LIMIT 1
    `;

    if (callingAgentResult.length === 0) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
      );
    }

    const callingAgent = callingAgentResult[0] as Agent;
    console.log(`[Create For User] Request from agent ${callingAgent.id} (${callingAgent.name})`);

    const body = await request.json();
    const { user_id, agent_name, description } = body;

    if (!user_id) {
      return NextResponse.json(
        { error: "user_id is required" },
        { status: 400 }
      );
    }

    if (!agent_name || typeof agent_name !== "string" || agent_name.trim().length === 0) {
      return NextResponse.json(
        { error: "agent_name is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    // Check how many assistants this user already has
    const userAssistantsResult = await sql`
      SELECT COUNT(*) as count FROM assistants WHERE created_by = ${user_id}
    `;
    const currentAssistantCount = parseInt(userAssistantsResult[0].count as string, 10);

    if (currentAssistantCount >= MAX_ASSISTANTS_PER_USER) {
      return NextResponse.json(
        { 
          error: `User has reached the maximum limit of ${MAX_ASSISTANTS_PER_USER} assistants`,
          current_count: currentAssistantCount,
          max_allowed: MAX_ASSISTANTS_PER_USER,
        },
        { status: 403 }
      );
    }

    // Generate API key for the new agent
    const newAgentApiKey = `vellum_${crypto.randomBytes(24).toString("base64url")}`;

    // Create the agent in the database
    const newAgentResult = await sql`
      INSERT INTO assistants (name, description, configuration, created_by)
      VALUES (
        ${agent_name.trim()},
        ${description || null},
        ${JSON.stringify({ 
          apiKey: newAgentApiKey,
          created_by_agent: callingAgent.id,
        })},
        ${user_id}
      )
      RETURNING *
    `;

    const newAgent = newAgentResult[0] as Agent;
    console.log(`[Create For User] Created agent ${newAgent.id} (${newAgent.name}) for user ${user_id}`);

    // Provision the agent infrastructure
    try {
      // Check for prequeued instance
      const prequeued = await getAvailablePrequeuedInstance();

      let gcsResult;
      if (prequeued) {
        gcsResult = await uploadAgentConfigToGCS(
          newAgent.id,
          newAgent.name,
          { apiKey: newAgentApiKey }
        );
      } else {
        gcsResult = await uploadAgentToGCS(
          newAgent.id,
          newAgent.name,
          { apiKey: newAgentApiKey }
        );
      }

      const instanceResult = await createAgentComputeInstance(
        newAgent.id,
        newAgent.name,
        gcsResult.bucket,
        gcsResult.prefix
      );

      // Update agent with compute config
      await sql`
        UPDATE assistants
        SET configuration = ${JSON.stringify({
          ...(newAgent.configuration as Record<string, unknown> || {}),
          compute: {
            instanceName: instanceResult.instanceName,
            zone: instanceResult.zone,
            machineType: instanceResult.machineType,
          },
          gcs: {
            bucket: gcsResult.bucket,
            prefix: gcsResult.prefix,
          },
        })},
        updated_at = NOW()
        WHERE id = ${newAgent.id}
      `;

      console.log(`[Create For User] Provisioned instance ${instanceResult.instanceName} for agent ${newAgent.id}`);
    } catch (provisionError) {
      console.error(`[Create For User] Failed to provision agent ${newAgent.id}:`, provisionError);
      
      // Update agent with error status
      await sql`
        UPDATE assistants
        SET configuration = ${JSON.stringify({
          ...(newAgent.configuration as Record<string, unknown> || {}),
          provisioningError: provisionError instanceof Error ? provisionError.message : "Provisioning failed",
        })},
        updated_at = NOW()
        WHERE id = ${newAgent.id}
      `;
    }

    const agentLink = `${APP_URL}/assistants/${newAgent.id}`;

    return NextResponse.json({
      success: true,
      agent: {
        id: newAgent.id,
        name: newAgent.name,
        description: newAgent.description,
        created_at: newAgent.createdAt,
      },
      link: agentLink,
      message: `Assistant "${newAgent.name}" created successfully. The user now has ${currentAssistantCount + 1}/${MAX_ASSISTANTS_PER_USER} assistants.`,
    });
  } catch (error: unknown) {
    console.error("[Create For User] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to create agent";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

/**
 * GET /api/assistants/create-for-user?user_id=xxx
 * 
 * Check how many assistants a user has and if they can create more.
 * Requires API key authentication.
 */
export async function GET(request: NextRequest) {
  const apiKey = request.headers.get("X-API-Key");

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing X-API-Key header" },
      { status: 401 }
    );
  }

  try {
    const sql = getDb();

    // Verify the API key belongs to a valid agent
    const callingAgentResult = await sql`
      SELECT * FROM assistants 
      WHERE configuration->>'apiKey' = ${apiKey}
      LIMIT 1
    `;

    if (callingAgentResult.length === 0) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("user_id");

    if (!userId) {
      return NextResponse.json(
        { error: "user_id query parameter is required" },
        { status: 400 }
      );
    }

    // Count user's assistants
    const userAssistantsResult = await sql`
      SELECT COUNT(*) as count FROM assistants WHERE created_by = ${userId}
    `;
    const currentCount = parseInt(userAssistantsResult[0].count as string, 10);

    return NextResponse.json({
      user_id: userId,
      current_assistant_count: currentCount,
      max_allowed: MAX_ASSISTANTS_PER_USER,
      can_create_more: currentCount < MAX_ASSISTANTS_PER_USER,
      remaining_slots: MAX_ASSISTANTS_PER_USER - currentCount,
    });
  } catch (error: unknown) {
    console.error("[Create For User] Error:", error);
    return NextResponse.json(
      { error: "Failed to check agent count" },
      { status: 500 }
    );
  }
}
