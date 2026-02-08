import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";

export interface User {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  profile_picture_url: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/profile?username=xxx - Get user profile by username
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
    const result = await sql`
      SELECT id, username, email, display_username as display_name, image as profile_picture_url, created_at, updated_at
      FROM "user"
      WHERE username = ${username}
    `;

    if (result.length === 0) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(result[0] as User);
  } catch (error) {
    console.error("Error fetching profile:", error);
    return NextResponse.json(
      { error: "Failed to fetch profile" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/profile - Update user profile
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { username, display_name, email, profile_picture_url } = body;

    if (!username) {
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 }
      );
    }

    const sql = getDb();

    const existing = await sql`SELECT id FROM "user" WHERE username = ${username}`;

    if (existing.length === 0) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const result = await sql`
      UPDATE "user"
      SET 
        display_username = COALESCE(${display_name}, display_username),
        email = COALESCE(${email}, email),
        image = COALESCE(${profile_picture_url}, image),
        updated_at = NOW()
      WHERE username = ${username}
      RETURNING id, username, email, display_username as display_name, image as profile_picture_url, created_at, updated_at
    `;

    return NextResponse.json(result[0] as User);
  } catch (error) {
    console.error("Error updating profile:", error);
    return NextResponse.json(
      { error: "Failed to update profile" },
      { status: 500 }
    );
  }
}
