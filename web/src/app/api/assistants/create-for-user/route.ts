import crypto from "crypto";

import { NextRequest, NextResponse } from "next/server";

import { Agent, getDb } from "@/lib/db";
import {
  createAssistantComputeInstance,
  uploadAssistantConfigToGCS,
  uploadAssistantToGCS,
  getAvailablePrequeuedInstance,
} from "@/lib/gcp";

const MAX_ASSISTANTS_PER_USER = 3;
const APP_URL = process.env.APP_URL || "http://localhost:3000";

/**
 * POST /api/assistants/create-for-user
 * 
 * Allows an assistant to create a new assistant for a user.
 * Requires API key authentication via X-API-Key header.
 * 
 * Body: {
 *   user_id: string,       // The user to create the assistant for
 *   assistant_name: string,    // Name for the new assistant
 *   description?: string,  // Optional description
 * }
 * 
 * Returns: {
 *   agent: Agent,
 *   link: string,          // Link to the new assistant's page
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

    // Verify the API key belongs to a valid assistant
    const callingAssistantResult = await sql`
      SELECT * FROM assistants 
      WHERE configuration->>'apiKey' = ${apiKey}
      LIMIT 1
    `;

    if (callingAssistantResult.length === 0) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
      );
    }

    const callingAssistant = callingAssistantResult[0] as Agent;
    console.log(`[Create For User] Request from assistant ${callingAssistant.id} (${callingAssistant.name})`);

    const body = await request.json();
    const { user_id, assistant_name, description } = body;

    if (!user_id) {
      return NextResponse.json(
        { error: "user_id is required" },
        { status: 400 }
      );
    }

    if (!assistant_name || typeof assistant_name !== "string" || assistant_name.trim().length === 0) {
      return NextResponse.json(
        { error: "assistant_name is required and must be a non-empty string" },
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

    // Generate API key for the new assistant
    const newAssistantApiKey = `vellum_${crypto.randomBytes(24).toString("base64url")}`;

    // Create the assistant in the database
    const newAssistantResult = await sql`
      INSERT INTO assistants (name, description, configuration, created_by)
      VALUES (
        ${assistant_name.trim()},
        ${description || null},
        ${JSON.stringify({ 
          apiKey: newAssistantApiKey,
          created_by_assistant: callingAssistant.id,
        })},
        ${user_id}
      )
      RETURNING *
    `;

    const newAssistant = newAssistantResult[0] as Agent;
    console.log(`[Create For User] Created assistant ${newAssistant.id} (${newAssistant.name}) for user ${user_id}`);

    // Provision the assistant infrastructure
    try {
      // Check for prequeued instance
      const prequeued = await getAvailablePrequeuedInstance();

      let gcsResult;
      if (prequeued) {
        gcsResult = await uploadAssistantConfigToGCS(
          newAssistant.id,
          newAssistant.name,
          { apiKey: newAssistantApiKey }
        );
      } else {
        gcsResult = await uploadAssistantToGCS(
          newAssistant.id,
          newAssistant.name,
          { apiKey: newAssistantApiKey }
        );
      }

      const instanceResult = await createAssistantComputeInstance(
        newAssistant.id,
        newAssistant.name,
        gcsResult.bucket,
        gcsResult.prefix
      );

      // Update assistant with compute config
      await sql`
        UPDATE assistants
        SET configuration = ${JSON.stringify({
          ...(newAssistant.configuration as Record<string, unknown> || {}),
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
        WHERE id = ${newAssistant.id}
      `;

      console.log(`[Create For User] Provisioned instance ${instanceResult.instanceName} for assistant ${newAssistant.id}`);
    } catch (provisionError) {
      console.error(`[Create For User] Failed to provision assistant ${newAssistant.id}:`, provisionError);
      
      // Update assistant with error status
      await sql`
        UPDATE assistants
        SET configuration = ${JSON.stringify({
          ...(newAssistant.configuration as Record<string, unknown> || {}),
          provisioningError: provisionError instanceof Error ? provisionError.message : "Provisioning failed",
        })},
        updated_at = NOW()
        WHERE id = ${newAssistant.id}
      `;
    }

    const assistantLink = `${APP_URL}/assistants/${newAssistant.id}`;

    return NextResponse.json({
      success: true,
      assistant: {
        id: newAssistant.id,
        name: newAssistant.name,
        description: newAssistant.description,
        created_at: newAssistant.createdAt,
      },
      link: assistantLink,
      message: `Assistant "${newAssistant.name}" created successfully. The user now has ${currentAssistantCount + 1}/${MAX_ASSISTANTS_PER_USER} assistants.`,
    });
  } catch (error: unknown) {
    console.error("[Create For User] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to create assistant";
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

    // Verify the API key belongs to a valid assistant
    const callingAssistantResult = await sql`
      SELECT * FROM assistants 
      WHERE configuration->>'apiKey' = ${apiKey}
      LIMIT 1
    `;

    if (callingAssistantResult.length === 0) {
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
      { error: "Failed to check assistant count" },
      { status: 500 }
    );
  }
}
