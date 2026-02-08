import { NextRequest, NextResponse } from "next/server";

import { Agent, getDb } from "@/lib/db";

/**
 * POST /api/agents/[id]/set-avatar
 * 
 * Allows an agent to set its global avatar.
 * Requires API key authentication via X-API-Key header.
 * 
 * Body: { avatar_url: string } or { avatar_base64: string, content_type: string }
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

    const body = await request.json();
    const { avatar_url, avatar_base64, content_type } = body;

    let finalAvatarUrl: string;

    if (avatar_url) {
      // Validate URL format
      try {
        new URL(avatar_url);
        finalAvatarUrl = avatar_url;
      } catch {
        return NextResponse.json(
          { error: "Invalid avatar_url format" },
          { status: 400 }
        );
      }
    } else if (avatar_base64 && content_type) {
      // For base64, we store as a data URL
      // In production, you'd upload to GCS and return the URL
      if (!content_type.startsWith("image/")) {
        return NextResponse.json(
          { error: "content_type must be an image type (e.g., image/png, image/jpeg)" },
          { status: 400 }
        );
      }
      
      // Validate base64
      try {
        atob(avatar_base64);
      } catch {
        return NextResponse.json(
          { error: "Invalid base64 data" },
          { status: 400 }
        );
      }

      // For now, store as data URL (small images only)
      // TODO: Upload to GCS for production
      finalAvatarUrl = `data:${content_type};base64,${avatar_base64}`;
      
      // Limit data URL size (100KB max)
      if (finalAvatarUrl.length > 100000) {
        return NextResponse.json(
          { error: "Avatar image too large. Max 100KB for base64. Use avatar_url for larger images." },
          { status: 400 }
        );
      }
    } else {
      return NextResponse.json(
        { error: "Either avatar_url or (avatar_base64 + content_type) is required" },
        { status: 400 }
      );
    }

    // Update agent configuration with avatar
    const currentConfig = agent.configuration as Record<string, unknown>;
    const newConfig = {
      ...currentConfig,
      avatar_url: finalAvatarUrl,
    };

    await sql`
      UPDATE agents
      SET configuration = ${JSON.stringify(newConfig)},
      updated_at = NOW()
      WHERE id = ${agentId}
    `;

    console.log(`[Set Avatar] Avatar set for agent ${agentId} (${agent.name})`);

    return NextResponse.json({
      message: "Avatar set successfully",
      avatar_url: finalAvatarUrl.startsWith("data:") 
        ? `data:${content_type};base64,[BASE64_DATA]` // Don't echo full data URL
        : finalAvatarUrl,
    });
  } catch (error) {
    console.error("[Set Avatar] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to set avatar";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

/**
 * GET /api/agents/[id]/set-avatar
 * 
 * Get the current avatar for an agent.
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

    const avatarUrl = (agent.configuration as Record<string, unknown>)?.avatar_url as string | undefined;

    return NextResponse.json({
      has_avatar: !!avatarUrl,
      avatar_url: avatarUrl || null,
    });
  } catch (error) {
    console.error("[Set Avatar] Error:", error);
    return NextResponse.json(
      { error: "Failed to get avatar" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/agents/[id]/set-avatar
 * 
 * Remove the avatar for an agent.
 * Requires API key authentication.
 */
export async function DELETE(
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

    // Remove avatar from configuration
    const currentConfig = agent.configuration as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { avatar_url: _, ...newConfig } = currentConfig;

    await sql`
      UPDATE agents
      SET configuration = ${JSON.stringify(newConfig)},
      updated_at = NOW()
      WHERE id = ${agentId}
    `;

    console.log(`[Set Avatar] Avatar removed for agent ${agentId} (${agent.name})`);

    return NextResponse.json({
      message: "Avatar removed successfully",
    });
  } catch (error) {
    console.error("[Set Avatar] Error:", error);
    return NextResponse.json(
      { error: "Failed to remove avatar" },
      { status: 500 }
    );
  }
}
