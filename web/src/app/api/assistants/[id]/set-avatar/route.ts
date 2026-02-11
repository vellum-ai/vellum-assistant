import { NextRequest, NextResponse } from "next/server";

import { verifyAssistantToken } from "@/lib/auth/assistant-tokens";
import { Assistant, getDb } from "@/lib/db";

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice(7);
}

async function authenticateAssistant(
  request: NextRequest,
  assistantId: string,
): Promise<NextResponse | null> {
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json(
      { error: "Missing or invalid Authorization header" },
      { status: 401 },
    );
  }
  const verified = await verifyAssistantToken(assistantId, token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  return null;
}

/**
 * POST /api/assistants/[id]/set-avatar
 *
 * Allows an assistant to set its global avatar.
 * Requires bearer token authentication via Authorization header.
 *
 * Body: { avatar_url: string } or { avatar_base64: string, content_type: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assistantId } = await params;

  const authError = await authenticateAssistant(request, assistantId);
  if (authError) return authError;

  try {
    const sql = getDb();

    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;
    if (result.length === 0) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    const assistant = result[0] as Assistant;

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

    // Update assistant configuration with avatar
    const currentConfig = assistant.configuration as Record<string, unknown>;
    const newConfig = {
      ...currentConfig,
      avatar_url: finalAvatarUrl,
    };

    await sql`
      UPDATE assistants
      SET configuration = ${JSON.stringify(newConfig)},
      updated_at = NOW()
      WHERE id = ${assistantId}
    `;

    console.log(`[Set Avatar] Avatar set for assistant ${assistantId} (${assistant.name})`);

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
 * GET /api/assistants/[id]/set-avatar
 *
 * Get the current avatar for an assistant.
 * Requires bearer token authentication.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assistantId } = await params;

  const authError = await authenticateAssistant(request, assistantId);
  if (authError) return authError;

  try {
    const sql = getDb();

    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;
    if (result.length === 0) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    const assistant = result[0] as Assistant;
    const avatarUrl = (assistant.configuration as Record<string, unknown>)?.avatar_url as string | undefined;

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
 * DELETE /api/assistants/[id]/set-avatar
 *
 * Remove the avatar for an assistant.
 * Requires bearer token authentication.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: assistantId } = await params;

  const authError = await authenticateAssistant(request, assistantId);
  if (authError) return authError;

  try {
    const sql = getDb();

    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;
    if (result.length === 0) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    const assistant = result[0] as Assistant;

    // Remove avatar from configuration
    const currentConfig = assistant.configuration as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { avatar_url: _, ...newConfig } = currentConfig;

    await sql`
      UPDATE assistants
      SET configuration = ${JSON.stringify(newConfig)},
      updated_at = NOW()
      WHERE id = ${assistantId}
    `;

    console.log(`[Set Avatar] Avatar removed for assistant ${assistantId} (${assistant.name})`);

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
