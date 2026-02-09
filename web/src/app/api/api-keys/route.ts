import crypto from "crypto";

import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";

// Available actions for API key scopes
export const AVAILABLE_ACTIONS = ["read", "write", "delete", "execute"] as const;
export type ApiKeyAction = (typeof AVAILABLE_ACTIONS)[number];

// Available entities for API key scopes
export const AVAILABLE_ENTITIES = ["assistants", "messages", "files", "settings"] as const;
export type ApiKeyEntity = (typeof AVAILABLE_ENTITIES)[number];

export interface ApiKeyScopes {
  actions: ApiKeyAction[];
  entities: ApiKeyEntity[];
  assistant_ids: string[]; // ["*"] for all, or specific assistant IDs
}

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScopes;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

// Generate a secure API key
function generateApiKey(): { key: string; prefix: string; hash: string } {
  const randomBytes = crypto.randomBytes(32);
  const key = `vellum_${randomBytes.toString("base64url")}`;
  const prefix = key.substring(0, 12); // "vellum_xxxx"
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  return { key, prefix, hash };
}

// Hash an API key for verification
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * GET /api/api-keys?username=xxx - List API keys for a user
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const username = searchParams.get("username");

    if (!username) {
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 }
      );
    }

    const sql = getDb();

    const userResult = await sql`SELECT id FROM "user" WHERE username = ${username}`;
    if (userResult.length === 0) {
      return NextResponse.json({ keys: [] });
    }

    const userId = userResult[0].id;

    // Get all API keys for user (excluding the hash for security)
    const keys = await sql`
      SELECT id, user_id, name, key_prefix, scopes, last_used_at, expires_at, created_at
      FROM api_keys
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;

    return NextResponse.json({ keys: keys as unknown as ApiKey[] });
  } catch (error) {
    console.error("Error listing API keys:", error);
    return NextResponse.json(
      { error: "Failed to list API keys" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/api-keys - Create a new API key
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { username, name, scopes, expires_in_days } = body;

    if (!username || !name) {
      return NextResponse.json(
        { error: "Username and name are required" },
        { status: 400 }
      );
    }

    const sql = getDb();

    // Get or create user
    const userResult = await sql`SELECT id FROM "user" WHERE username = ${username}`;
    if (userResult.length === 0) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }
    const userId = userResult[0].id;

    // Validate and set default scopes
    const finalScopes: ApiKeyScopes = {
      actions: scopes?.actions?.filter((a: string) => AVAILABLE_ACTIONS.includes(a as ApiKeyAction)) || ["read"],
      entities: scopes?.entities?.filter((e: string) => AVAILABLE_ENTITIES.includes(e as ApiKeyEntity)) || ["assistants"],
      assistant_ids: scopes?.assistant_ids || ["*"],
    };

    // Generate the key
    const { key, prefix, hash } = generateApiKey();

    // Calculate expiration
    const expiresAt = expires_in_days
      ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Store the key
    const result = await sql`
      INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, expires_at)
      VALUES (${userId}, ${name}, ${prefix}, ${hash}, ${JSON.stringify(finalScopes)}, ${expiresAt})
      RETURNING id, user_id, name, key_prefix, scopes, expires_at, created_at
    `;

    // Return the full key ONLY on creation (it won't be retrievable later)
    return NextResponse.json({
      ...result[0],
      key, // Full key shown only once!
      message: "Save this key now - it won't be shown again!",
    });
  } catch (error) {
    console.error("Error creating API key:", error);
    return NextResponse.json(
      { error: "Failed to create API key" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/api-keys - Delete an API key
 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const keyId = searchParams.get("id");
    const username = searchParams.get("username");

    if (!keyId || !username) {
      return NextResponse.json(
        { error: "Key ID and username are required" },
        { status: 400 }
      );
    }

    const sql = getDb();

    const userResult = await sql`SELECT id FROM "user" WHERE username = ${username}`;
    if (userResult.length === 0) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }
    const userId = userResult[0].id;

    // Delete the key (only if owned by user)
    const result = await sql`
      DELETE FROM api_keys
      WHERE id = ${keyId} AND user_id = ${userId}
      RETURNING id
    `;

    if (result.length === 0) {
      return NextResponse.json(
        { error: "API key not found or not owned by user" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, deleted: keyId });
  } catch (error) {
    console.error("Error deleting API key:", error);
    return NextResponse.json(
      { error: "Failed to delete API key" },
      { status: 500 }
    );
  }
}
